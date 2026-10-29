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
import { MAINTENANCE_BUNDLED, PROJECT_ROOT, MIGRATIONS_ROOT } from "./runtime-context"
const LOCK = [1953065063, 1768776039]

export type Migration = { version: string; name: string; sha256: string; sql: string }
export type MigrationLedgerEntry = { version: string; name: string; sha256: string }
export const MIGRATION_LEDGER_EXISTS_SQL = "SELECT to_regclass('app.schema_migrations') IS NOT NULL AS present"
export const MIGRATION_LEDGER_SQL = "SELECT version, name, sha256 FROM app.schema_migrations ORDER BY version"

/** 账本必须是审核清单的完整前缀；未知、重复、缺口或篡改均拒绝。 */
export function validateMigrationHistory(rows: Record<string, unknown>[], migrations: readonly MigrationLedgerEntry[]): MigrationLedgerEntry[] {
  if (rows.length > migrations.length) throw new DatabaseBoundaryError("MIGRATION_DRIFT", "已执行迁移与审核文件不一致，拒绝继续。")
  return rows.map((row, index) => {
    const expected = migrations[index]
    if (!expected || row.version !== expected.version || row.name !== expected.name || row.sha256 !== expected.sha256) {
      throw new DatabaseBoundaryError("MIGRATION_DRIFT", "已执行迁移与审核文件不一致，拒绝继续。")
    }
    return { version: expected.version, name: expected.name, sha256: expected.sha256 }
  })
}

/** 仅迁移身份读取账本；不存在时只返回空前缀，不创建表。 */
export async function inspectMigrationHistory(client: DatabaseInspectionClient, migrations: readonly MigrationLedgerEntry[]): Promise<{ present: boolean; ledger: MigrationLedgerEntry[] }> {
  const presence = await client.query(MIGRATION_LEDGER_EXISTS_SQL)
  if (presence.rows.length !== 1 || typeof presence.rows[0].present !== "boolean") {
    throw new DatabaseBoundaryError("MIGRATION_DRIFT", "无法核对项目迁移账本，拒绝继续。")
  }
  if (!presence.rows[0].present) return { present: false, ledger: [] }
  const result = await client.query(MIGRATION_LEDGER_SQL)
  return { present: true, ledger: validateMigrationHistory(result.rows, migrations) }
}

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
    const expected = path.join(await realpath(PROJECT_ROOT), ...(MAINTENANCE_BUNDLED ? ["maintenance", "migrations"] : ["migrations"]))
    if (await realpath(MIGRATIONS_ROOT) !== expected) sourceError()
    if (MAINTENANCE_BUNDLED) await verifyTrustedPath(path.dirname(MIGRATIONS_ROOT), true)
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
    // 先核对已有账本。漂移不能通过CREATE/REVOKE等写入被掩盖。
    const history = await inspectMigrationHistory(client, migrations)
    if (!history.present) {
      await client.query(`CREATE TABLE app.schema_migrations (
      version text PRIMARY KEY, name text NOT NULL UNIQUE,
      sha256 text NOT NULL CHECK (length(sha256) = 64),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
      // 账本只由迁移身份维护；不放宽运行身份的任何账本权限。
      await client.query("REVOKE ALL ON TABLE app.schema_migrations FROM qintopia_image_app")
    }
    const applied: string[] = []
    const skipped: string[] = []
    const completed = new Set(history.ledger.map((row) => row.version))
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

if (!MAINTENANCE_BUNDLED && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
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
