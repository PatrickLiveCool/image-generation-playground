import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createDatabasePool } from "../../lib/database"
import {
  DatabaseBoundaryError, readDatabaseConfiguration, verifyDatabaseIdentity,
  type DatabaseConfiguration, type DatabaseInspectionClient,
} from "../../lib/database-target"
import { approvedMigrations } from "./migration-catalog"

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url))
const MIGRATIONS_ROOT = path.join(PROJECT_ROOT, "migrations")
const LOCK = [1953065063, 1768776039]

type Migration = { version: string; name: string; sha256: string; sql: string }

function sourceError(): never {
  throw new DatabaseBoundaryError("MIGRATION_SOURCE", "迁移来源或审核哈希不符合固定项目清单。")
}

async function verifyTrustedPath(filename: string, directory: boolean) {
  const stat = await lstat(filename)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o022) !== 0 || (stat.uid !== 0 && stat.uid !== process.getuid?.())) sourceError()
}

/** 只接收一个文件名和内容，校验对照固定审核清单；没有任意迁移目录参数。 */
export function verifyApprovedMigration(name: string, sql: string): Migration {
  if (!/^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/.test(name)) sourceError()
  const sha256 = createHash("sha256").update(sql).digest("hex")
  if (!Object.hasOwn(approvedMigrations, name) || approvedMigrations[name] !== sha256) sourceError()
  return { version: name.slice(0, 4), name, sha256, sql }
}

export async function loadMigrations(): Promise<Migration[]> {
  try {
    await verifyTrustedPath(PROJECT_ROOT, true)
    await verifyTrustedPath(MIGRATIONS_ROOT, true)
    if (await realpath(MIGRATIONS_ROOT) !== path.join(await realpath(PROJECT_ROOT), "migrations")) sourceError()
    const names = (await readdir(MIGRATIONS_ROOT)).sort()
    if (names.length !== Object.keys(approvedMigrations).length) sourceError()
    const migrations: Migration[] = []
    for (const name of names) {
      if (!Object.hasOwn(approvedMigrations, name)) sourceError()
      const filename = path.join(MIGRATIONS_ROOT, name)
      await verifyTrustedPath(filename, false)
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 ||
            (stat.uid !== 0 && stat.uid !== process.getuid?.()) || stat.size > 1_048_576) sourceError()
        migrations.push(verifyApprovedMigration(name, await file.readFile("utf8")))
      } finally { await file.close() }
    }
    if (new Set(migrations.map((entry) => entry.version)).size !== migrations.length) sourceError()
    return migrations
  } catch (error) {
    if (error instanceof DatabaseBoundaryError) throw error
    return sourceError()
  }
}

/** 可注入只实现 query 的客户端以证明错误身份未收到变更；SQL 始终来自固定目录。 */
export async function runMigrations(
  client: DatabaseInspectionClient,
  configuration: DatabaseConfiguration,
): Promise<{ applied: string[]; skipped: string[] }> {
  if (configuration.purpose !== "migration") sourceError()
  const migrations = await loadMigrations()
  await verifyDatabaseIdentity(client, configuration)
  let locked = false
  let transaction = false
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", LOCK)
    locked = true
    await client.query("BEGIN")
    transaction = true
    await client.query(`CREATE TABLE IF NOT EXISTS app.schema_migrations (
      version text PRIMARY KEY, name text NOT NULL UNIQUE,
      sha256 text NOT NULL CHECK (length(sha256) = 64),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    // 账本只由迁移身份维护；业务表默认 CRUD 不应让运行身份改写迁移历史。
    await client.query("REVOKE ALL ON TABLE app.schema_migrations FROM qintopia_image_app")
    const history = await client.query("SELECT version, name, sha256 FROM app.schema_migrations ORDER BY version")
    const known = new Map(migrations.map((migration) => [migration.version, migration]))
    for (const row of history.rows) {
      const expected = known.get(String(row.version))
      if (!expected || expected.name !== row.name || expected.sha256 !== row.sha256) {
        throw new DatabaseBoundaryError("MIGRATION_DRIFT", "已执行迁移与审核文件不一致，拒绝继续。")
      }
    }
    const applied: string[] = []
    const skipped: string[] = []
    const completed = new Set(history.rows.map((row) => row.version))
    for (const migration of migrations) {
      if (completed.has(migration.version)) { skipped.push(migration.name); continue }
      await client.query(migration.sql)
      await client.query("INSERT INTO app.schema_migrations (version, name, sha256) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migration.sha256])
      applied.push(migration.name)
    }
    await client.query("COMMIT")
    transaction = false
    return { applied, skipped }
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => {})
    if (error instanceof DatabaseBoundaryError) throw error
    throw new DatabaseBoundaryError("MIGRATION_FAILED", "迁移未完成；请核对本项目迁移账本后再决定是否重试。")
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1, $2)", LOCK).catch(() => {})
  }
}

export async function migrateDatabase(environment: NodeJS.ProcessEnv = process.env) {
  // 在创建连接前加载/验证配置和完整文件集。
  const configuration = readDatabaseConfiguration("migration", environment)
  await loadMigrations()
  const pool = createDatabasePool("migration", environment)
  try {
    const client = await pool.connect()
    try { return await runMigrations(client, configuration) }
    finally { client.release() }
  } catch (error) {
    if (error instanceof DatabaseBoundaryError) throw error
    throw new DatabaseBoundaryError("MIGRATION_FAILED", "迁移未完成；请核对本项目迁移账本后再决定是否重试。")
  } finally { await pool.end() }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length !== 2) {
    console.error("迁移命令不接受目录或 SQL 参数。")
    process.exitCode = 1
  } else {
    migrateDatabase().then((result) => console.log(JSON.stringify(result))).catch((error: unknown) => {
      console.error(error instanceof DatabaseBoundaryError ? error.message : "迁移失败。")
      process.exitCode = 1
    })
  }
}
