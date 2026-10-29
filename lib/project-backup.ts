import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { verifyDatabaseIdentity, type DatabaseConfiguration, type DatabaseInspectionClient } from "./database-target"
import { validateReleaseIdentity } from "./release-identity"
import { decryptProviderSecret, providerConfigurationKey } from "./provider-secret"
import { validateProviderConfiguration } from "./provider-configuration-validation"
import { approvedMigrations } from "../scripts/database/migration-catalog"
import { verifyProjectPhysicalSchema } from "../scripts/database/schema-contract"

export const MAX_PROJECT_BACKUP_BYTES = 64 * 1024 * 1024
export const MAX_PROJECT_RECOVERY_SECRETS_BYTES = 64 * 1024
const RESTORE_BATCH_ROWS = 100
const AAD = Buffer.from("qintopia-image:structured-project-backup:v1")
// 与固定迁移运行器共用项目锁；恢复/备份不能穿过正在提交的DDL。
const PROJECT_OPERATION_LOCK = [1953065063, 1768776039]
type Row = Record<string, unknown>
type Check = (value: unknown) => boolean
const text = (maximum: number, minimum = 0): Check => value => typeof value === "string" && value.length >= minimum && value.length <= maximum && !value.includes("\0")
const optional = (check: Check): Check => value => value === null || check(value)
const integer = (minimum = 1, maximum = 2_147_483_647): Check => value => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
const oneOf = (...values: unknown[]): Check => value => values.includes(value)
const bool: Check = value => typeof value === "boolean"
const id = text(128, 1)
// PostgreSQL及现有创作接口允许全部128位UUID；不能因其版本位使合法源记录无法备份。
const uuid: Check = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const digest: Check = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
const date: Check = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const bigint: Check = value => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807")
const array = (maximum: number): Check => value => Array.isArray(value) && value.length <= maximum
const timestamp = { createdAt: date, updatedAt: date }

// 每个标识符都是审核过的常量；归档不提供表、列、SQL、角色或路径。
const TABLES = {
  user: { id, name: text(256, 1), email: text(320, 1), emailVerified: bool, image: optional(text(8192)), ...timestamp,
    username: (value => typeof value === "string" && /^[a-z0-9_-]{3,32}$/.test(value)) as Check, displayUsername: optional(text(128)),
    role: oneOf("admin", "user"), banned: bool, banReason: optional(text(5000)), banExpires: optional(date), mustChangePassword: bool,
    temporaryPasswordExpiresAt: optional(date), temporaryPasswordUsedAt: optional(date) },
  account: { id, accountId: id, providerId: oneOf("credential"), userId: id, accessToken: oneOf(null), refreshToken: oneOf(null), idToken: oneOf(null),
    accessTokenExpiresAt: oneOf(null), refreshTokenExpiresAt: oneOf(null), scope: oneOf(null), password: text(4096, 1), ...timestamp },
  account_audit: { id: bigint, actorId: id, subjectId: id, action: oneOf("bootstrap-admin", "create-user", "sign-in", "sign-out", "change-password", "disable", "restore", "reset-password"), createdAt: date },
  provider_settings: { singleton: oneOf(1), baseUrl: text(2048, 1), tokenCiphertext: text(24000, 1), apiMode: oneOf("images", "chat"), models: array(5000), mappings: array(100), modelsSynced: bool, revision: integer(), updatedBy: id, updatedAt: date },
  provider_config_audit: { id: bigint, actorId: id, revision: integer(), action: oneOf("save"), createdAt: date },
  provider_request_slots: { userId: id, requestId: uuid, fingerprint: digest, status: oneOf("active", "finished", "unknown"), acceptedAt: date, deadlineAt: date },
  creations: { ownerId: id, id: uuid, title: text(60, 1), revision: integer(), nextVersion: integer(), ...timestamp },
  generation_runs: { ownerId: id, id: uuid, creationId: uuid, clientRequestId: uuid, fingerprint: digest, version: integer(), parentVersionId: optional(uuid),
    status: oneOf("preparing", "generating", "saving", "complete", "failed", "unknown", "save_pending"), prompt: text(5000), mappingId: text(128, 1), modelLabel: text(256, 1), aspectRatio: text(32, 1), quality: text(32, 1), mode: oneOf("text-to-image", "image-editing"),
    providerBaseUrl: text(2048, 1), providerApiMode: oneOf("images", "chat"), providerModelId: text(256, 1), providerRevision: integer(), manifestKey: text(1024, 1), outputKey: text(1024, 1), outputAssetId: uuid,
    failureCode: optional(value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)), ...timestamp, deadlineAt: date },
  private_assets: { ownerId: id, id: uuid, creationId: uuid, runId: uuid, key: text(1024, 1), kind: oneOf("image", "document"), mediaType: text(128, 1), byteLength: integer(1, 20 * 1024 * 1024), sha256: digest, name: optional(text(255, 1)), createdAt: date },
} satisfies Record<string, Record<string, Check>>
type Table = keyof typeof TABLES
export const PROJECT_BACKUP_TABLES = Object.freeze(Object.keys(TABLES) as Table[])
type Records = Record<Table, Row[]>
export type ProjectRecoverySecrets = { BETTER_AUTH_SECRET: string; PROVIDER_CONFIG_KEY: string; ASSET_ACCESS_SECRET: string }
export type ProjectBackupStorage = { bucket: string; region: string; prefix: "image-playground/private/v1" }
export type ProjectBackupPayload = {
  schema: 1; application: "qintopia-image"; database: "qintopia_image"; schemaName: "app"; createdAt: string
  release: Record<string, unknown>; migrations: Array<{ name: string; sha256: string }>; storage: ProjectBackupStorage; secrets: ProjectRecoverySecrets; tables: Records; contentSha256: string
}
export class ProjectBackupError extends Error {
  constructor(readonly code: string, message = "项目备份或恢复校验失败；未开放任意 SQL 或跨项目恢复。") { super(message); this.name = "ProjectBackupError" }
}
function requireSafe(condition: unknown, code = "BACKUP_INVALID"): asserts condition { if (!condition) throw new ProjectBackupError(code) }
function object(value: unknown, fields: readonly string[]): asserts value is Row {
  requireSafe(value && typeof value === "object" && !Array.isArray(value))
  requireSafe(Object.keys(value).sort().join(",") === [...fields].sort().join(","))
}
function canonical(value: unknown, depth = 0): string {
  requireSafe(depth <= 20)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key], depth + 1)}`).join(",")}}`
  requireSafe(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
  return JSON.stringify(value)
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
const migrationList = () => Object.entries(approvedMigrations).sort(([a], [b]) => a.localeCompare(b)).map(([name, sha256]) => ({ name, sha256 }))
function validateSecrets(value: unknown): asserts value is ProjectRecoverySecrets {
  object(value, ["BETTER_AUTH_SECRET", "PROVIDER_CONFIG_KEY", "ASSET_ACCESS_SECRET"])
  requireSafe(text(4096, 32)(value.BETTER_AUTH_SECRET) && text(4096, 32)(value.ASSET_ACCESS_SECRET), "BACKUP_SECRET_INVALID")
  try { providerConfigurationKey(value as ProjectRecoverySecrets) } catch { throw new ProjectBackupError("BACKUP_SECRET_INVALID") }
  requireSafe(Object.values(value).every(item => typeof item === "string" && !/[\r\n\0]/.test(item)) &&
    Buffer.byteLength(JSON.stringify(value) + "\n") <= MAX_PROJECT_RECOVERY_SECRETS_BYTES, "BACKUP_SECRET_INVALID")
}
export function projectRecoverySecrets(environment: NodeJS.ProcessEnv): ProjectRecoverySecrets {
  const secrets = { BETTER_AUTH_SECRET: environment.BETTER_AUTH_SECRET, PROVIDER_CONFIG_KEY: environment.PROVIDER_CONFIG_KEY, ASSET_ACCESS_SECRET: environment.ASSET_ACCESS_SECRET }
  validateSecrets(secrets)
  return secrets
}
function validateStorage(value: unknown): asserts value is ProjectBackupStorage {
  object(value, ["bucket", "region", "prefix"])
  requireSafe(typeof value.bucket === "string" && /^[a-z0-9][a-z0-9-]{0,50}-[0-9]{5,20}$/.test(value.bucket) &&
    typeof value.region === "string" && /^[a-z]{2}-[a-z]+(?:-[a-z0-9]+)?$/.test(value.region) && value.prefix === "image-playground/private/v1", "BACKUP_STORAGE_INVALID")
}
export function projectBackupStorage(environment: NodeJS.ProcessEnv): ProjectBackupStorage {
  const storage = { bucket: environment.COS_BUCKET, region: environment.COS_REGION, prefix: "image-playground/private/v1" }
  validateStorage(storage)
  return storage
}
function validateRelease(value: unknown) {
  object(value, ["schema", "application", "version", "revision", "platform", "builtAt", "browserWorkspaceSchema", "assetCapabilityVersion", "databaseMode", "assetAccessProtocol", "database"])
  try { validateReleaseIdentity(value) } catch { throw new ProjectBackupError("BACKUP_RELEASE_INVALID") }
  const release = value as Row
  requireSafe(release.schema === 2 && release.databaseMode === "postgresql" && release.assetAccessProtocol === "account-private-v1", "BACKUP_RELEASE_INVALID")
  const database = release.database as Row
  requireSafe(database?.name === "qintopia_image" && database.schema === "app" && canonical(database.migrations) === canonical(migrationList()), "BACKUP_RELEASE_INVALID")
}
function index(rows: Row[], key: (row: Row) => string) {
  const entries = rows.map(row => [key(row), row] as const)
  requireSafe(new Set(entries.map(([key]) => key)).size === rows.length)
  return new Map(entries)
}
const compound = (...items: unknown[]) => JSON.stringify(items)
const prefix = (row: Row) => `image-playground/private/v1/${createHash("sha256").update(String(row.ownerId)).digest("hex")}/${row.creationId}/${row.id}`
function validateRecords(tables: Records, secrets: ProjectRecoverySecrets) {
  object(tables, PROJECT_BACKUP_TABLES)
  let total = 0
  for (const table of PROJECT_BACKUP_TABLES) {
    const rows = tables[table], fields = TABLES[table] as Record<string, Check>
    requireSafe(Array.isArray(rows) && (total += rows.length) <= 100_000)
    for (const row of rows) { object(row, Object.keys(fields)); for (const [column, check] of Object.entries(fields)) requireSafe(check(row[column])) }
  }
  const users = index(tables.user, row => String(row.id))
  index(tables.user, row => String(row.username)); index(tables.user, row => String(row.email))
  index(tables.account, row => String(row.id)); index(tables.account, row => compound(row.userId, row.providerId)); index(tables.account, row => compound(row.accountId, row.providerId))
  for (const row of tables.account) requireSafe(users.has(String(row.userId)) && row.accountId === row.userId)
  index(tables.account_audit, row => String(row.id)); index(tables.provider_config_audit, row => String(row.id))
  for (const row of tables.account_audit) requireSafe(users.has(String(row.actorId)) && users.has(String(row.subjectId)))
  for (const row of tables.provider_config_audit) requireSafe(users.has(String(row.actorId)))
  requireSafe(tables.provider_settings.length <= 1)
  for (const row of tables.provider_settings) {
    requireSafe(users.has(String(row.updatedBy)))
    try {
      const apiKey = decryptProviderSecret(row.tokenCiphertext, secrets)
      validateProviderConfiguration({ revision: row.revision, settings: { baseUrl: row.baseUrl, apiMode: row.apiMode, apiKey }, models: row.models, mappings: row.mappings, modelsSynced: row.modelsSynced })
    } catch { throw new ProjectBackupError("BACKUP_PROVIDER_INVALID") }
  }
  const slots = index(tables.provider_request_slots, row => compound(row.userId, row.requestId))
  for (const row of tables.provider_request_slots) requireSafe(users.has(String(row.userId)) && Date.parse(String(row.deadlineAt)) - Date.parse(String(row.acceptedAt)) === 300_000)
  const creations = index(tables.creations, row => compound(row.ownerId, row.id))
  for (const row of tables.creations) requireSafe(users.has(String(row.ownerId)))
  const runs = index(tables.generation_runs, row => compound(row.ownerId, row.id))
  index(tables.generation_runs, row => compound(row.ownerId, row.creationId, row.version))
  index(tables.generation_runs, row => compound(row.ownerId, row.outputAssetId))
  for (const row of tables.generation_runs) {
    const creation = creations.get(compound(row.ownerId, row.creationId)), slot = slots.get(compound(row.ownerId, row.id))
    requireSafe(creation && slot && slot.fingerprint === row.fingerprint && row.id === row.clientRequestId && Number(creation.nextVersion) > Number(row.version))
    requireSafe(row.manifestKey === `${prefix(row)}/manifest.json` && row.outputKey === `${prefix(row)}/outputs/final`)
    if (row.parentVersionId !== null) {
      const parent = runs.get(compound(row.ownerId, row.parentVersionId))
      requireSafe(parent && parent.creationId === row.creationId && parent.status === "complete" && Number(parent.version) < Number(row.version) && row.mode === "image-editing")
    }
  }
  const assets = index(tables.private_assets, row => compound(row.ownerId, row.id))
  index(tables.private_assets, row => String(row.key))
  for (const row of tables.private_assets) {
    const run = runs.get(compound(row.ownerId, row.runId))
    requireSafe(run && run.creationId === row.creationId)
    const suffix = String(row.key).slice(prefix(run).length)
    requireSafe(String(row.key).startsWith(prefix(run)) && /^(?:\/outputs\/final|\/inputs\/(?:reference-[12]|document-image-[12]|document))$/.test(suffix))
    if (suffix === "/outputs/final") requireSafe(row.id === run.outputAssetId && row.kind === "image")
    if (row.kind === "image") requireSafe(oneOf("image/png", "image/jpeg", "image/webp", "image/gif")(row.mediaType) && suffix !== "/inputs/document")
    else requireSafe(suffix === "/inputs/document" && Number(row.byteLength) <= 10 * 1024 * 1024)
  }
  for (const row of tables.generation_runs) if (row.status === "complete") {
    const output = assets.get(compound(row.ownerId, row.outputAssetId))
    requireSafe(output && output.runId === row.id && output.key === row.outputKey && output.kind === "image")
  }
}
export function validateProjectBackupPayload(value: unknown): ProjectBackupPayload {
  object(value, ["schema", "application", "database", "schemaName", "createdAt", "release", "migrations", "storage", "secrets", "tables", "contentSha256"])
  requireSafe(value.schema === 1 && value.application === "qintopia-image" && value.database === "qintopia_image" && value.schemaName === "app" && date(value.createdAt))
  requireSafe(Date.parse(String(value.createdAt)) <= Date.now() + 300_000 && digest(value.contentSha256))
  validateRelease(value.release); validateSecrets(value.secrets); validateStorage(value.storage)
  requireSafe(canonical(value.migrations) === canonical(migrationList()))
  const { contentSha256, ...content } = value
  requireSafe(hash(content) === contentSha256, "BACKUP_DIGEST_INVALID")
  validateRecords(value.tables as Records, value.secrets)
  return value as ProjectBackupPayload
}
function base64(value: unknown, length?: number): Buffer {
  requireSafe(typeof value === "string" && value.length > 0)
  const decoded = Buffer.from(value, "base64")
  requireSafe(decoded.toString("base64") === value && (length === undefined || decoded.length === length))
  return decoded
}
export function encodeProjectBackup(payload: ProjectBackupPayload, key: Uint8Array): Buffer {
  validateProjectBackupPayload(payload); requireSafe(key.length === 32, "BACKUP_KEY_INVALID")
  const plain = Buffer.from(canonical(payload))
  requireSafe(plain.length <= MAX_PROJECT_BACKUP_BYTES, "BACKUP_TOO_LARGE")
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.from(JSON.stringify({ schema: 1, application: "qintopia-image", algorithm: "aes-256-gcm", nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") }))
}
export function decodeProjectBackup(bytes: Uint8Array, key: Uint8Array): ProjectBackupPayload {
  try {
    requireSafe(bytes.length > 0 && bytes.length <= MAX_PROJECT_BACKUP_BYTES * 1.4 && key.length === 32)
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    object(envelope, ["schema", "application", "algorithm", "nonce", "ciphertext", "tag"])
    requireSafe(envelope.schema === 1 && envelope.application === "qintopia-image" && envelope.algorithm === "aes-256-gcm")
    const decipher = createDecipheriv("aes-256-gcm", key, base64(envelope.nonce, 12))
    decipher.setAAD(AAD); decipher.setAuthTag(base64(envelope.tag, 16))
    const ciphertext = base64(envelope.ciphertext)
    requireSafe(ciphertext.length <= MAX_PROJECT_BACKUP_BYTES)
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return validateProjectBackupPayload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)))
  } catch { throw new ProjectBackupError("BACKUP_AUTHENTICATION_FAILED", "备份认证、归属或内容校验失败；恢复未开始。") }
}
const quoted = (name: string) => `"${name}"` // 仅接受本文件TABLES常量，绝不使用归档标识符。
const columns = (table: Table) => Object.keys(TABLES[table])
async function verifyTarget(client: DatabaseInspectionClient, configuration: DatabaseConfiguration) {
  requireSafe(configuration.purpose === "migration", "BACKUP_IDENTITY_REQUIRED")
  await verifyDatabaseIdentity(client, configuration)
  const ledger = await client.query("SELECT version, name, sha256 FROM app.schema_migrations ORDER BY name")
  const expectedLedger = migrationList().map(entry => ({ version: entry.name.slice(0, 4), ...entry }))
  requireSafe(canonical(ledger.rows) === canonical(expectedLedger), "BACKUP_MIGRATION_MISMATCH")
  await verifyProjectPhysicalSchema(client)
}
export { verifyTarget as verifyProjectDatabaseContract }
async function readRecords(client: DatabaseInspectionClient): Promise<Records> {
  const result = {} as Records
  let count = 0, bytes = 0
  for (const table of PROJECT_BACKUP_TABLES) {
    result[table] = []
    const order = table === "provider_settings" ? ["singleton"] : table === "provider_request_slots" ? ["userId", "requestId"] : ["creations", "generation_runs", "private_assets"].includes(table) ? ["ownerId", "id"] : ["id"]
    for (let offset = 0; ; offset += 1000) {
      const rows = (await client.query(`SELECT ${columns(table).map(quoted).join(",")} FROM app.${quoted(table)} ORDER BY ${order.map(quoted).join(",")} LIMIT $1 OFFSET $2`, [1000, offset])).rows
      const serialized = JSON.stringify(rows)
      count += rows.length; bytes += Buffer.byteLength(serialized)
      requireSafe(count <= 100_000 && bytes <= MAX_PROJECT_BACKUP_BYTES, "BACKUP_TOO_LARGE")
      result[table].push(...JSON.parse(serialized))
      if (rows.length < 1000) break
    }
  }
  return result
}
function normalizedRestoreTables(payload: ProjectBackupPayload): Records {
  const tables = structuredClone(payload.tables)
  for (const row of tables.generation_runs) if (["preparing", "generating", "saving"].includes(String(row.status))) row.status = "unknown"
  for (const row of tables.provider_request_slots) if (row.status === "active") row.status = "unknown"
  for (const row of tables.user) if (row.mustChangePassword) {
    row.temporaryPasswordExpiresAt = new Date(Date.parse(payload.createdAt) - 86_400_000).toISOString()
    row.temporaryPasswordUsedAt = payload.createdAt
  }
  tables.generation_runs.sort((a, b) => Number(a.version) - Number(b.version))
  return tables
}
function tableDigest(tables: Records) {
  return hash(Object.fromEntries(PROJECT_BACKUP_TABLES.map(table => [table, [...tables[table]].sort((a, b) => canonical(a).localeCompare(canonical(b)))])))
}
export async function exportProjectBackup(client: DatabaseInspectionClient, configuration: DatabaseConfiguration, release: Record<string, unknown>, secrets: ProjectRecoverySecrets, key: Uint8Array, storage: ProjectBackupStorage): Promise<Buffer> {
  validateRelease(release); validateSecrets(secrets); validateStorage(storage); requireSafe(key.length === 32, "BACKUP_KEY_INVALID")
  await verifyTarget(client, configuration)
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    await client.query("SELECT pg_advisory_xact_lock_shared($1, $2)", PROJECT_OPERATION_LOCK)
    await verifyTarget(client, configuration)
    const content = { schema: 1 as const, application: "qintopia-image" as const, database: "qintopia_image" as const, schemaName: "app" as const,
      createdAt: new Date().toISOString(), release, migrations: migrationList(), storage, secrets, tables: await readRecords(client) }
    const encoded = encodeProjectBackup({ ...content, contentSha256: hash(content) }, key)
    await client.query("COMMIT")
    return encoded
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error instanceof ProjectBackupError ? error : new ProjectBackupError("BACKUP_EXPORT_FAILED")
  }
}
export type ProjectRestoreVerification = { verified: true; contentSha256: string; rowCount: number } | { notRestored: true; contentSha256: string; rowCount: 0 }
export async function verifyRestoredProjectBackup(client: DatabaseInspectionClient, configuration: DatabaseConfiguration, bytes: Uint8Array, key: Uint8Array, expectedStorage: ProjectBackupStorage): Promise<ProjectRestoreVerification> {
  const payload = decodeProjectBackup(bytes, key)
  validateStorage(expectedStorage)
  requireSafe(canonical(payload.storage) === canonical(expectedStorage), "BACKUP_STORAGE_MISMATCH")
  await verifyTarget(client, configuration)
  // 先取得会话共享锁再开启快照，避免等待并发COMMIT时固定了过旧的“空库”快照。
  await client.query("SELECT pg_advisory_lock_shared($1, $2)", PROJECT_OPERATION_LOCK)
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    try {
      await verifyTarget(client, configuration)
      const actual = await readRecords(client)
      const rowCount = Object.values(actual).reduce((sum, rows) => sum + rows.length, 0)
      const matches = tableDigest(actual) === tableDigest(normalizedRestoreTables(payload))
      requireSafe(matches || rowCount === 0, "BACKUP_RESTORE_MISMATCH")
      await client.query("COMMIT")
      return matches ? { verified: true, contentSha256: payload.contentSha256, rowCount } : { notRestored: true, contentSha256: payload.contentSha256, rowCount: 0 }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw error instanceof ProjectBackupError ? error : new ProjectBackupError("BACKUP_RESTORE_MISMATCH")
    }
  } finally {
    // 失败必须向调用者传播；维护入口随后关闭该连接，不能把会话锁留给连接池复用。
    await client.query("SELECT pg_advisory_unlock_shared($1, $2)", PROJECT_OPERATION_LOCK)
  }
}
/** 在服务器记录“开始恢复”之前完成无写入预检；拒绝输入不应被记为未知提交。 */
export async function preflightProjectRestore(client: DatabaseInspectionClient, configuration: DatabaseConfiguration, bytes: Uint8Array, key: Uint8Array, expectedStorage: ProjectBackupStorage): Promise<{ ready: true; contentSha256: string; rowCount: number }> {
  const payload = decodeProjectBackup(bytes, key)
  validateStorage(expectedStorage)
  requireSafe(canonical(payload.storage) === canonical(expectedStorage), "BACKUP_STORAGE_MISMATCH")
  await verifyTarget(client, configuration)
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
  try {
    await client.query("SELECT pg_advisory_xact_lock_shared($1, $2)", PROJECT_OPERATION_LOCK)
    await verifyTarget(client, configuration)
    for (const table of PROJECT_BACKUP_TABLES) requireSafe(!(await client.query(`SELECT 1 FROM app.${quoted(table)} LIMIT 1`)).rows.length, "BACKUP_TARGET_NOT_EMPTY")
    await client.query("COMMIT")
    return { ready: true, contentSha256: payload.contentSha256, rowCount: Object.values(payload.tables).reduce((sum, rows) => sum + rows.length, 0) }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error instanceof ProjectBackupError ? error : new ProjectBackupError("BACKUP_PREFLIGHT_FAILED", "恢复预检未完成，尚未开始写入。")
  }
}
export async function restoreProjectBackup(client: DatabaseInspectionClient, configuration: DatabaseConfiguration, bytes: Uint8Array, key: Uint8Array, expectedStorage: ProjectBackupStorage): Promise<{ restored: true; contentSha256: string; rowCount: number; secrets: ProjectRecoverySecrets }> {
  // 必须在任何目标变更（包括BEGIN/LOCK）前认证并验证完整来源与关联关系。
  const payload = decodeProjectBackup(bytes, key), tables = normalizedRestoreTables(payload)
  validateStorage(expectedStorage)
  requireSafe(canonical(payload.storage) === canonical(expectedStorage), "BACKUP_STORAGE_MISMATCH")
  await verifyTarget(client, configuration)
  await client.query("BEGIN")
  let committing = false
  try {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", PROJECT_OPERATION_LOCK)
    await client.query(`LOCK TABLE ${PROJECT_BACKUP_TABLES.map(table => `app.${quoted(table)}`).join(",")} IN ACCESS EXCLUSIVE MODE`)
    await verifyTarget(client, configuration)
    for (const table of PROJECT_BACKUP_TABLES) requireSafe(!(await client.query(`SELECT 1 FROM app.${quoted(table)} LIMIT 1`)).rows.length, "BACKUP_TARGET_NOT_EMPTY")
    for (const table of PROJECT_BACKUP_TABLES) {
      const names = columns(table), identity = table === "account_audit" || table === "provider_config_audit"
      for (let start = 0; start < tables[table].length; start += RESTORE_BATCH_ROWS) {
        const batch = tables[table].slice(start, start + RESTORE_BATCH_ROWS)
        const values = batch.flatMap(row => names.map(name => name === "models" || name === "mappings" ? JSON.stringify(row[name]) : row[name]))
        const placeholders = batch.map((_, rowIndex) => `(${names.map((_, columnIndex) => `$${rowIndex * names.length + columnIndex + 1}`).join(",")})`).join(",")
        await client.query(`INSERT INTO app.${quoted(table)} (${names.map(quoted).join(",")})${identity ? " OVERRIDING SYSTEM VALUE" : ""} VALUES ${placeholders}`, values)
      }
    }
    for (const table of ["account_audit", "provider_config_audit"] as const) {
      await client.query(`SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('app.${table}', 'id'), COALESCE(max(id),1), count(*)>0) FROM app.${table}`)
    }
    committing = true
    await client.query("COMMIT")
    return { restored: true, contentSha256: payload.contentSha256, rowCount: Object.values(tables).reduce((sum, rows) => sum + rows.length, 0), secrets: payload.secrets }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    if (committing) throw new ProjectBackupError("BACKUP_RESTORE_UNCONFIRMED", "恢复提交结果未确认；保持维护状态并只读核对，禁止清空目标或自动重放。")
    throw error instanceof ProjectBackupError ? error : new ProjectBackupError("BACKUP_RESTORE_FAILED", "恢复未完成；保持维护状态并核对，未清空目标。")
  }
}
