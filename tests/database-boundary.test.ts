import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import type { Pool } from "pg"
import { createDatabasePool } from "../lib/database"
import { DATABASE_IDENTITY_SQL, readDatabaseConfiguration, verifyDatabaseIdentity } from "../lib/database-target"
import { loadMigrations, runMigrations, verifyApprovedMigration } from "../scripts/database/migrate"
import { assertLocalFixture } from "../scripts/database/bootstrap-local.mjs"
import { localFixtureMarker } from "../scripts/database/bootstrap-local.mjs"
import { assertMatchingFixtureIdentity, assertSyntheticAccountRows } from "../scripts/database/test-fixture"

const environment = {
  NODE_ENV: "test" as const,
  IMAGE_DATABASE_TARGET: "local",
  IMAGE_DATABASE_URL: "postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image",
  IMAGE_MIGRATION_DATABASE_URL: "postgresql://qintopia_image_migrator:synthetic-local-migrator-only@127.0.0.1:32768/qintopia_image",
}

function identity(migration = false): Record<string, unknown> {
  const user = migration ? "qintopia_image_migrator" : "qintopia_image_app"
  return {
    database: "qintopia_image", current_user: user, session_user: user, schema: "app", search_path: "app, pg_catalog",
    rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
    database_owner: "qintopia_image_migrator", schema_owner: "qintopia_image_migrator",
    can_connect: true, can_use_schema: true, can_create_database_objects: migration, can_temp: migration,
    can_create_schema_objects: migration, has_memberships: false, can_create_outside_schema: false,
    can_write_outside_schema: false, can_write_sequences_outside_schema: false,
    unexpected_object_owner: false, runtime_table_permissions_invalid: false,
    runtime_sequence_permissions_invalid: false, runtime_can_access_ledger: false,
  }
}

test("database target rejects endpoint, database, schema options and identity before constructing any pool", () => {
  const badUrls = [
    environment.IMAGE_DATABASE_URL.replace("127.0.0.1", "10.80.0.15"),
    environment.IMAGE_DATABASE_URL.replace("32768", "5432"),
    environment.IMAGE_DATABASE_URL.replace("/qintopia_image", "/other_application"),
    environment.IMAGE_DATABASE_URL.replace("qintopia_image_app", "qintopia_image_migrator"),
    `${environment.IMAGE_DATABASE_URL}?options=-c%20search_path%3Dpublic`,
    `${environment.IMAGE_DATABASE_URL}?host=other-host`,
    `${environment.IMAGE_DATABASE_URL}#secret`,
    "postgresql://qintopia_image_app@127.0.0.1:32768/qintopia_image",
  ]
  let constructions = 0
  for (const url of badUrls) {
    assert.throws(() => createDatabasePool("runtime", { ...environment, IMAGE_DATABASE_URL: url }, () => {
      constructions++; throw new Error("must never construct")
    }), /固定目标清单/)
  }
  for (const target of [undefined, "", "staging"]) {
    assert.throws(() => readDatabaseConfiguration("runtime", { ...environment, IMAGE_DATABASE_TARGET: target }), /固定目标清单/)
  }
  assert.equal(constructions, 0)
})

test("runtime and migration pools ignore PG overrides, enforce limits and await read-only identity checks", async () => {
  for (const purpose of ["runtime", "migration"] as const) {
    let inspection = 0
    createDatabasePool(purpose, { ...environment, PGHOST: "untrusted", PGOPTIONS: "-c search_path=public" }, (options) => {
      assert.equal(options.host, "127.0.0.1")
      assert.equal(options.port, 32768)
      assert.equal(options.max, purpose === "runtime" ? 4 : 1)
      assert.equal(options.connectionString, undefined)
      assert.equal(options.options, "-c search_path=app,pg_catalog")
      assert.equal(options.connectionTimeoutMillis, 5000)
      assert.equal(options.statement_timeout, 15000)
      assert.equal(options.lock_timeout, 5000)
      void options.onConnect({ query: async (sql: string) => {
        assert.equal(sql, DATABASE_IDENTITY_SQL)
        inspection++
        return { rows: [identity(purpose === "migration")] }
      } } as never)
      return new EventEmitter() as Pool
    })
    await Promise.resolve()
    assert.equal(inspection, 1)
  }
})

test("identity and effective permission violations issue only one read-only query", async () => {
  const runtime = readDatabaseConfiguration("runtime", environment)
  const violations = {
    database: "other_application", current_user: "postgres", session_user: "postgres", schema: "public",
    search_path: "app, public, pg_catalog", schema_owner: "postgres", database_owner: "postgres",
    rolsuper: true, rolcreatedb: true, rolcreaterole: true, rolreplication: true, rolbypassrls: true,
    can_connect: false, can_use_schema: false, can_create_database_objects: true, can_temp: true,
    can_create_schema_objects: true, has_memberships: true, can_create_outside_schema: true,
    can_write_outside_schema: true, can_write_sequences_outside_schema: true,
    unexpected_object_owner: true, runtime_table_permissions_invalid: true,
    runtime_sequence_permissions_invalid: true, runtime_can_access_ledger: true,
  }
  for (const [key, value] of Object.entries(violations)) {
    const sent: string[] = []
    await assert.rejects(verifyDatabaseIdentity({ query: async (sql) => {
      sent.push(sql); return { rows: [{ ...identity(), [key]: value }] }
    } }, runtime), /边界/, key)
    assert.deepEqual(sent, [DATABASE_IDENTITY_SQL])
  }
  await assert.rejects(verifyDatabaseIdentity({ query: async () => { throw new Error(environment.IMAGE_DATABASE_URL) } }, runtime),
    (error: Error) => !error.message.includes("postgresql:") && !error.message.includes("synthetic"))
})

test("fixed migration source rejects SQL alterations and alternate paths before executing any SQL", async () => {
  const sql = await readFile(new URL("../migrations/0001-accounts.sql", import.meta.url), "utf8")
  assert.equal(verifyApprovedMigration("0001-accounts.sql", sql).version, "0001")
  for (const unsafe of ["CREATE DATABASE other;", "CREATE ROLE other;", "GRANT ALL ON SCHEMA public TO PUBLIC;", "COPY app.x FROM PROGRAM 'echo bad';", "\\i /tmp/untrusted.sql"]) {
    assert.throws(() => verifyApprovedMigration("0001-accounts.sql", `${sql}\n${unsafe}`), /审核哈希/)
  }
  assert.throws(() => verifyApprovedMigration("../0001-accounts.sql", sql), /审核哈希/)
  assert.throws(() => verifyApprovedMigration("0002-unreviewed.sql", sql), /审核哈希/)
  assert.deepEqual((await loadMigrations()).map(item => item.name), ["0001-accounts.sql", "0002-provider-settings.sql", "0003-provider-admission.sql"])
})

test("migration identity failure never sends ledger creation or advisory lock", async () => {
  const sent: string[] = []
  await assert.rejects(runMigrations({ query: async (sql) => {
    sent.push(sql); return { rows: [{ ...identity(true), current_user: "another_app" }] }
  } }, readDatabaseConfiguration("migration", environment)), /边界/)
  assert.deepEqual(sent, [DATABASE_IDENTITY_SQL])
})

test("migration ledger skips prior SQL, rejects drift and rolls back failures while releasing lock", async () => {
  const migrations = await loadMigrations()
  const migration = migrations[0]
  const configuration = readDatabaseConfiguration("migration", environment)
  for (const scenario of ["applied", "skipped", "drift", "failed"] as const) {
    const sent: string[] = []
    const query = async (sql: string) => {
      sent.push(sql)
      if (sql === DATABASE_IDENTITY_SQL) return { rows: [identity(true)] }
      if (sql.startsWith("SELECT version")) return { rows: scenario === "skipped" || scenario === "drift" ?
        [{ version: migration.version, name: migration.name, sha256: scenario === "drift" ? "bad" : migration.sha256 }] : [] }
      if (scenario === "failed" && sql === migration.sql) throw new Error("private PostgreSQL diagnostic")
      return { rows: [] }
    }
    if (scenario === "drift" || scenario === "failed") {
      await assert.rejects(runMigrations({ query }, configuration), scenario === "drift" ? /拒绝继续/ : /迁移未完成/)
      assert.ok(sent.includes("ROLLBACK"))
      assert.ok(!sent.includes("COMMIT"))
    } else {
      const result = await runMigrations({ query }, configuration)
      assert.deepEqual(result[scenario], scenario === "applied" ? migrations.map(item => item.name) : [migration.name])
      if (scenario === "skipped") assert.deepEqual(result.applied, migrations.slice(1).map(item => item.name))
      assert.ok(sent.includes("COMMIT"))
    }
    assert.equal(sent.includes(migration.sql), scenario === "applied" || scenario === "failed")
    assert.equal(sent.at(-1), "SELECT pg_advisory_unlock($1, $2)")
    assert.ok(sent.indexOf("SELECT pg_advisory_lock($1, $2)") < sent.indexOf("BEGIN"))
  }
})

test("local bootstrap refuses mismatched container, labels, stopped state or non-loopback binding", () => {
  const fixture = {
    Id: "a".repeat(64), Name: "/image-playground-acceptance-pg", State: { Running: true },
    Config: { Labels: { "codex.project": "image-generation-playground", "codex.task": "01a17dff-bdc4-7712-9e0a-e553ae2240d6" } },
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "32768" }] } },
  }
  assert.doesNotThrow(() => assertLocalFixture(fixture))
  for (const patch of [
    { Id: "" }, { Id: "not-a-container-id" }, { Name: "/other-app-postgres" }, { State: { Running: false } },
    { Config: { Labels: { "codex.project": "other-app" } } },
    { NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "32768" }] } } },
    { NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5432" }] } } },
  ]) assert.throws(() => assertLocalFixture({ ...fixture, ...patch }), /未执行初始化/)
})

test("account fixture rejects missing markers, other containers and forwarded servers before cleanup", () => {
  const containerId = "a".repeat(64)
  const fixture = {
    database: "qintopia_image", databaseOid: "16384", serverStartedAt: "1793316726.123456",
    serverVersion: "180006", marker: localFixtureMarker(containerId),
  }
  assert.doesNotThrow(() => assertMatchingFixtureIdentity(containerId, fixture, fixture))
  for (const patch of [
    { marker: null }, { marker: "synthetic" }, { marker: localFixtureMarker("b".repeat(64)) },
    { database: "other_application" }, { databaseOid: "16385" },
    { serverStartedAt: "1793316727.123456" }, { serverVersion: "180004" },
  ]) {
    assert.throws(() => assertMatchingFixtureIdentity(containerId, { ...fixture, ...patch }, fixture), /禁止清理/)
    assert.throws(() => assertMatchingFixtureIdentity(containerId, fixture, { ...fixture, ...patch }), /禁止清理/)
  }
})

test("account fixture requires exact synthetic username allowlist and ID-bound internal email", () => {
  const account = { id: "synthetic-id", username: "test_admin", email: "synthetic-id@accounts.invalid" }
  assert.doesNotThrow(() => assertSyntheticAccountRows([]))
  assert.doesNotThrow(() => assertSyntheticAccountRows([account]))
  for (const patch of [
    { username: "real_admin" }, { username: "Test_Admin" }, { email: "person@example.com" },
    { email: "another-id@accounts.invalid" }, { id: null },
  ]) assert.throws(() => assertSyntheticAccountRows([account, { ...account, ...patch }]), /禁止清理/)
})
