import { constants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"
import { authConfiguration } from "../../lib/auth/config"
import { AccountError } from "../../lib/auth/errors"
import { createMaintenanceDatabasePool } from "../../lib/database"
import { DatabaseBoundaryError, readDatabaseConfiguration, verifyDatabaseIdentity, type DatabaseConfiguration, type DatabaseInspectionClient, type DatabasePurpose } from "../../lib/database-target"
import { decryptProviderSecret, providerConfigurationKey } from "../../lib/provider-secret"
import { ProjectBackupError, verifyProjectDatabaseContract } from "../../lib/project-backup"
import { approvedMigrations } from "./migration-catalog"
import { inspectMigrationHistory, loadMigrations, runMigrations, type Migration, type MigrationLedgerEntry } from "./migrate"
import { PROJECT_ROOT } from "./runtime-context"
import { runRecoveryMaintenance } from "./recovery-io"
import { runAdministratorMaintenance } from "./administrator"

export const MAINTENANCE_COMMANDS = ["describe", "preflight", "migrate", "verify", "backup", "restore-preflight", "restore", "verify-restore", "bootstrap-admin", "verify-bootstrap-admin"] as const
export type MaintenanceCommand = typeof MAINTENANCE_COMMANDS[number]
export const MAINTENANCE_CONNECTION_BUDGET = Object.freeze({ applicationProcesses: 2, perApplication: 4, maintenance: 1, total: 9 })
export type MaintenanceDatabaseContract = {
  name: "qintopia_image"; schema: "app"; minVersion: "0004"; maxVersion: "0004"
  migrations: { name: string; sha256: string }[]
}
export type MaintenanceRelease = {
  schema: 2; application: "qintopia-image"; version: string; revision: string; platform: "linux/amd64"; builtAt: string
  browserWorkspaceSchema: 1; assetCapabilityVersion: 1; databaseMode: "postgresql"; assetAccessProtocol: "account-private-v1"
  database: MaintenanceDatabaseContract
}
type Client = DatabaseInspectionClient & { release: () => void }
type Pool = { connect: () => Promise<Client>; end: () => Promise<unknown> }
export type MaintenanceDependencies = {
  pool: (purpose: DatabasePurpose, environment: NodeJS.ProcessEnv) => Pool
  verifySchema: (client: DatabaseInspectionClient, configuration: DatabaseConfiguration) => Promise<void>
  release: () => Promise<unknown>
}
export type MaintenanceStatus = {
  command: "preflight" | "migrate" | "verify"; application: "qintopia-image"
  release: { version: string; revision: string }; target: DatabaseConfiguration["target"]; database: "qintopia_image"; schema: "app"
  ledger: MigrationLedgerEntry[]; pending: string[]; compatible: boolean; secretsVerified: true
  connectionBudget: typeof MAINTENANCE_CONNECTION_BUDGET
  applied?: string[]; skipped?: string[]
}

function failure(code: string, message: string): never { throw new DatabaseBoundaryError(code, message) }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","))
}
export function maintenanceDatabaseContract(): MaintenanceDatabaseContract {
  return { name: "qintopia_image", schema: "app", minVersion: "0004", maxVersion: "0004",
    migrations: Object.entries(approvedMigrations).sort(([a], [b]) => a.localeCompare(b)).map(([name, sha256]) => ({ name, sha256 })) }
}

/** 只接受与此审核运行器相符的账号制品；旧匿名协议不能启动维护。 */
export function validateMaintenanceRelease(value: unknown): MaintenanceRelease {
  const keys = ["schema", "application", "version", "revision", "platform", "builtAt", "browserWorkspaceSchema", "assetCapabilityVersion", "databaseMode", "assetAccessProtocol", "database"]
  const expected = maintenanceDatabaseContract()
  if (!exact(value, keys) || value.schema !== 2 || value.application !== "qintopia-image" || value.platform !== "linux/amd64" ||
      typeof value.version !== "string" || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value.version) ||
      typeof value.revision !== "string" || !/^[0-9a-f]{40}$/.test(value.revision) ||
      typeof value.builtAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value.builtAt) || !Number.isFinite(Date.parse(value.builtAt)) ||
      value.browserWorkspaceSchema !== 1 || value.assetCapabilityVersion !== 1 || value.databaseMode !== "postgresql" || value.assetAccessProtocol !== "account-private-v1" ||
      !exact(value.database, ["name", "schema", "minVersion", "maxVersion", "migrations"]) ||
      value.database.name !== expected.name || value.database.schema !== expected.schema || value.database.minVersion !== expected.minVersion || value.database.maxVersion !== expected.maxVersion ||
      !Array.isArray(value.database.migrations) || value.database.migrations.length !== expected.migrations.length ||
      value.database.migrations.some((entry, index) => !exact(entry, ["name", "sha256"]) || entry.name !== expected.migrations[index].name || entry.sha256 !== expected.migrations[index].sha256)) {
    failure("MAINTENANCE_RELEASE", "维护运行器与账号制品身份或审核迁移契约不符。")
  }
  return value as unknown as MaintenanceRelease
}

export async function readMaintenanceRelease(): Promise<MaintenanceRelease> {
  try {
    const handle = await open(path.join(PROJECT_ROOT, "release.json"), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 || stat.size < 1 || (stat.mode & 0o022) !== 0 ||
          (stat.uid !== 0 && stat.uid !== process.getuid?.())) throw new Error("untrusted identity")
      return validateMaintenanceRelease(JSON.parse(await handle.readFile("utf8")))
    } finally { await handle.close() }
  } catch (error) {
    if (error instanceof DatabaseBoundaryError) throw error
    return failure("MAINTENANCE_RELEASE", "固定制品身份缺失或无法安全读取。")
  }
}

function validateProcessEnvironment(environment: NodeJS.ProcessEnv) {
  if (Object.entries(environment).some(([key, value]) => value && (/^PG[A-Z_0-9]*$/.test(key) || ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(key)))) {
    failure("MAINTENANCE_ENVIRONMENT", "维护进程继承了不允许的运行参数。")
  }
}
export function readAdministratorConfiguration(environment: NodeJS.ProcessEnv): DatabaseConfiguration {
  validateProcessEnvironment(environment)
  if (["IMAGE_MIGRATION_DATABASE_URL", "IMAGE_RECOVERY_KEY", "BETTER_AUTH_SECRET", "PROVIDER_CONFIG_KEY", "ASSET_ACCESS_SECRET",
    "COS_SECRET_ID", "COS_SECRET_KEY", "COS_SESSION_TOKEN", "BOOTSTRAP_ADMIN_USERNAME", "BOOTSTRAP_ADMIN_NAME", "BOOTSTRAP_ADMIN_PASSWORD"].some(key => environment[key])) {
    failure("MAINTENANCE_ENVIRONMENT", "管理员初始化只接收运行数据库凭据和受保护FD输入。")
  }
  return readDatabaseConfiguration("runtime", environment)
}
export function readMaintenanceConfigurations(environment: NodeJS.ProcessEnv): { runtime: DatabaseConfiguration; migration: DatabaseConfiguration } {
  validateProcessEnvironment(environment)
  // 两套连接均先完成配置核验；第二套错误不能在第一套已连接后才发现。
  const runtime = readDatabaseConfiguration("runtime", environment), migration = readDatabaseConfiguration("migration", environment)
  return { runtime, migration }
}
export function validateMaintenanceEnvironment(environment: NodeJS.ProcessEnv): { runtime: DatabaseConfiguration; migration: DatabaseConfiguration } {
  const { runtime, migration } = readMaintenanceConfigurations(environment)
  try {
    authConfiguration(runtime.target === "production" ? { ...environment, NODE_ENV: "production" } : environment)
    providerConfigurationKey(environment)
  } catch { failure("MAINTENANCE_SECRETS", "认证或模型加密配置缺失、格式无效或无法核验。") }
  return { runtime, migration }
}

async function withClient<T>(purpose: DatabasePurpose, environment: NodeJS.ProcessEnv, dependencies: MaintenanceDependencies,
  configuration: DatabaseConfiguration, operation: (client: Client) => Promise<T>): Promise<T> {
  const pool = dependencies.pool(purpose, environment)
  try {
    const client = await pool.connect()
    try {
      await verifyDatabaseIdentity(client, configuration)
      return await operation(client)
    } finally { client.release() }
  } finally { await pool.end() }
}

async function inspect(environment: NodeJS.ProcessEnv, dependencies: MaintenanceDependencies, configuration: ReturnType<typeof validateMaintenanceEnvironment>, migrations: Migration[]): Promise<MigrationLedgerEntry[]> {
  // close先于下一身份建池，整个维护命令的实际连接上限为1。
  await withClient("runtime", environment, dependencies, configuration.runtime, async client => {
    const table = await client.query("SELECT to_regclass('app.provider_settings') IS NOT NULL AS present")
    if (table.rows.length !== 1 || typeof table.rows[0].present !== "boolean") failure("MAINTENANCE_SECRETS", "无法核验模型配置存储状态。")
    if (table.rows[0].present) {
      const secrets = await client.query('SELECT "tokenCiphertext" FROM app.provider_settings WHERE singleton=1')
      if (secrets.rows.length > 1) failure("MAINTENANCE_SECRETS", "模型加密配置无法核验。")
      try { for (const row of secrets.rows) decryptProviderSecret(row.tokenCiphertext, environment) }
      catch { failure("MAINTENANCE_SECRETS", "模型加密配置无法解密，请核对原有恢复密钥。") }
    }
  })
  return withClient("migration", environment, dependencies, configuration.migration, async client => {
    const { ledger } = await inspectMigrationHistory(client, migrations)
    if (ledger.length === migrations.length) await dependencies.verifySchema(client, configuration.migration)
    return ledger
  })
}

export async function runMaintenance(command: MaintenanceCommand, environment: NodeJS.ProcessEnv = process.env, overrides: Partial<MaintenanceDependencies> = {}) {
  if (!MAINTENANCE_COMMANDS.includes(command)) failure("MAINTENANCE_COMMAND", "维护命令不受支持。")
  const migrations = await loadMigrations()
  if (command === "describe") {
    return { application: "qintopia-image", protocol: "account-private-v1", database: maintenanceDatabaseContract(),
      commands: [...MAINTENANCE_COMMANDS], connectionBudget: MAINTENANCE_CONNECTION_BUDGET }
  }
  const dependencies: MaintenanceDependencies = { pool: createMaintenanceDatabasePool, release: readMaintenanceRelease, verifySchema: verifyProjectDatabaseContract, ...overrides }
  const release = validateMaintenanceRelease(await dependencies.release())
  try {
    if (command === "bootstrap-admin" || command === "verify-bootstrap-admin") {
      const runtime = readAdministratorConfiguration(environment)
      return await runAdministratorMaintenance(command, release, operation => withClient("runtime", environment, dependencies, runtime, operation))
    }
    const restoring = command === "restore-preflight" || command === "restore" || command === "verify-restore"
    const configuration = restoring ? readMaintenanceConfigurations(environment) : validateMaintenanceEnvironment(environment)
    if (command === "backup" || command === "restore-preflight" || command === "restore" || command === "verify-restore") {
      return await runRecoveryMaintenance(command, environment, release, configuration.migration, {
        runtime: () => withClient("runtime", environment, dependencies, configuration.runtime, async () => {}),
        migration: operation => withClient("migration", environment, dependencies, configuration.migration, operation),
      })
    }
    let ledger = await inspect(environment, dependencies, configuration, migrations)
    let migrated: { applied: string[]; skipped: string[] } | undefined
    if (command === "migrate") {
      migrated = await withClient("migration", environment, dependencies, configuration.migration,
        client => runMigrations(client, configuration.migration))
      ledger = await inspect(environment, dependencies, configuration, migrations)
    }
    const pending = migrations.slice(ledger.length).map(item => item.name)
    const compatible = pending.length === 0 && ledger.at(-1)?.version === release.database.maxVersion
    if (command !== "preflight" && !compatible) failure("MIGRATION_REQUIRED", "数据库尚未达到此制品的审核迁移版本。")
    const result: MaintenanceStatus = {
      command, application: "qintopia-image", release: { version: release.version, revision: release.revision },
      target: configuration.runtime.target, database: "qintopia_image", schema: "app", ledger, pending, compatible,
      secretsVerified: true, connectionBudget: MAINTENANCE_CONNECTION_BUDGET, ...migrated,
    }
    return result
  } catch (error) {
    if (error instanceof DatabaseBoundaryError || error instanceof ProjectBackupError || error instanceof AccountError) throw error
    return failure("MAINTENANCE_DATABASE", "数据库维护未能确认完成，请先执行对应的只读核对。")
  }
}

export function maintenanceError(error: unknown) {
  return { error: error instanceof DatabaseBoundaryError || error instanceof ProjectBackupError || error instanceof AccountError ? { code: error.code, message: error.message } :
    { code: "MAINTENANCE_FAILED", message: "维护未能确认完成，请核对固定配置和项目迁移状态。" } }
}
