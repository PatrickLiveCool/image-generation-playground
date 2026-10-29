import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import type { PoolClient } from "pg"
import { createDatabasePool, getDatabase, closeDatabase, withTransaction } from "../lib/database"
import { readDatabaseConfiguration, verifyDatabaseIdentity } from "../lib/database-target"
import { loadMigrations, migrateDatabase } from "../scripts/database/migrate"
import { assertAccountTestFixture } from "../scripts/database/test-fixture"
import { inspectLocalFixture } from "../scripts/database/bootstrap-local.mjs"

if (process.env.IMAGE_DATABASE_INTEGRATION !== "1") {
  throw new Error("数据库集成测试需要显式 IMAGE_DATABASE_INTEGRATION=1 和已初始化的专用本地夹具。")
}

const localEnvironment = {
  NODE_ENV: "test" as const,
  IMAGE_DATABASE_TARGET: "local",
  IMAGE_DATABASE_URL: "postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image",
  IMAGE_MIGRATION_DATABASE_URL: "postgresql://qintopia_image_migrator:synthetic-local-migrator-only@127.0.0.1:32768/qintopia_image",
}

test("isolated PostgreSQL verifies migration locking/idempotence, runtime CRUD and denied DDL", async () => {
  // 所有配置来自本测试的固定本地合成值，不继承宿主的任何数据库连接串。
  Object.assign(process.env, localEnvironment)
  await closeDatabase()
  const results = await Promise.all([migrateDatabase(localEnvironment), migrateDatabase(localEnvironment)])
  const migrations = await loadMigrations()
  const applied = results.flatMap(result => result.applied)
  assert.equal(new Set(applied).size, applied.length)
  assert.ok(applied.length <= migrations.length)
  assert.ok(results.reduce((count, result) => count + result.skipped.length, 0) >= migrations.length)
  const runtime = await getDatabase()
  await assertAccountTestFixture(runtime)
  assert.equal(await getDatabase(), runtime)
  assert.equal(runtime.options.max, 4)
  const migrator = createDatabasePool("migration", localEnvironment)
  assert.equal(migrator.options.max, 1)
  let fixtureCreated = false
  try {
    const history = await migrator.query("SELECT version, sha256 FROM app.schema_migrations")
    assert.equal(history.rowCount, migrations.length)
    assert.deepEqual(history.rows.map(row => row.version).sort(), migrations.map(item => item.version))
    for (const row of history.rows) assert.match(row.sha256, /^[a-f0-9]{64}$/)
    await migrator.query("CREATE TABLE app.database_boundary_fixture (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text NOT NULL)")
    fixtureCreated = true
    const inserted = await runtime.query("INSERT INTO app.database_boundary_fixture (value) VALUES ($1) RETURNING id", ["synthetic"])
    const id = inserted.rows[0].id
    await runtime.query("UPDATE app.database_boundary_fixture SET value = $1 WHERE id = $2", ["updated", id])
    assert.equal((await runtime.query("SELECT value FROM app.database_boundary_fixture WHERE id = $1", [id])).rows[0].value, "updated")
    assert.ok((await runtime.query("SELECT nextval('app.database_boundary_fixture_id_seq') AS next")).rows[0].next)
    assert.equal(await withTransaction(async (client) => {
      await client.query("INSERT INTO app.database_boundary_fixture (value) VALUES ('transaction-committed')")
      return "committed"
    }), "committed")
    await assert.rejects(withTransaction(async (client) => {
      await client.query("INSERT INTO app.database_boundary_fixture (value) VALUES ('transaction-rolled-back')")
      throw new Error("synthetic application failure")
    }), /synthetic application failure/)
    assert.equal((await runtime.query("SELECT count(*)::integer AS count FROM app.database_boundary_fixture WHERE value = 'transaction-rolled-back'")).rows[0].count, 0)

    const denied = [
      "CREATE TABLE app.database_boundary_forbidden (id integer)",
      "ALTER TABLE app.database_boundary_fixture ADD COLUMN forbidden integer",
      "CREATE SCHEMA database_boundary_forbidden",
      "CREATE ROLE database_boundary_forbidden",
      "SET ROLE qintopia_image_migrator",
      "CREATE TEMP TABLE database_boundary_forbidden (id integer)",
      "SELECT * FROM app.schema_migrations",
      "UPDATE app.schema_migrations SET sha256 = repeat('0', 64)",
    ]
    const client = await runtime.connect()
    try {
      for (const sql of denied) {
        await client.query("BEGIN")
        try {
          await assert.rejects(client.query(sql), (error: { code?: string }) => error.code === "42501", sql)
        } finally { await client.query("ROLLBACK") }
      }
    } finally { client.release() }
    assert.equal((await runtime.query("DELETE FROM app.database_boundary_fixture WHERE id = $1", [id])).rowCount, 1)
  } finally {
    if (fixtureCreated) await migrator.query("DROP TABLE app.database_boundary_fixture")
    await Promise.all([migrator.end(), closeDatabase()])
  }
})

test("real cross-schema sequence USAGE and UPDATE grants fail the runtime boundary", async () => {
  const runtime = createDatabasePool("runtime", localEnvironment)
  let client: PoolClient | undefined
  let created = false
  const container = inspectLocalFixture()
  function fixtureSql(sql: string) {
    execFileSync("docker", ["exec", "-i", container.Id, "psql", "-X", "-U", "image_test_root", "-d", "qintopia_image", "-v", "ON_ERROR_STOP=1"], {
      input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000,
    })
  }
  try {
    await assertAccountTestFixture(runtime)
    client = await runtime.connect()
    // 全部对象只在已核验本容器/本库的新合成 schema 中；已有同名 schema 会失败，不覆盖。
    fixtureSql("CREATE SCHEMA database_boundary_sequence_fixture AUTHORIZATION image_test_root;")
    created = true
    fixtureSql("CREATE SEQUENCE database_boundary_sequence_fixture.synthetic_sequence; GRANT USAGE ON SCHEMA database_boundary_sequence_fixture TO qintopia_image_app;")
    const configuration = readDatabaseConfiguration("runtime", localEnvironment)
    for (const privilege of ["USAGE", "UPDATE"]) {
      fixtureSql(`GRANT ${privilege} ON SEQUENCE database_boundary_sequence_fixture.synthetic_sequence TO qintopia_image_app;`)
      // 两种权限分别可以推进/修改序列；验证用真实授权结果，不只断言 SQL 字符串。
      const sql = privilege === "USAGE" ?
        "SELECT nextval('database_boundary_sequence_fixture.synthetic_sequence') AS value" :
        "SELECT setval('database_boundary_sequence_fixture.synthetic_sequence', 42) AS value"
      assert.ok((await client.query(sql)).rows[0].value)
      await assert.rejects(verifyDatabaseIdentity(client, configuration), /边界/)
      fixtureSql(`REVOKE ${privilege} ON SEQUENCE database_boundary_sequence_fixture.synthetic_sequence FROM qintopia_image_app;`)
      await verifyDatabaseIdentity(client, configuration)
    }
  } finally {
    try {
      if (created) fixtureSql("DROP SCHEMA database_boundary_sequence_fixture CASCADE;")
    } finally {
      client?.release()
      await runtime.end()
    }
  }
})
