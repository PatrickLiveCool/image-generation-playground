import assert from "node:assert/strict"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { test } from "node:test"
import { readDatabaseConfiguration } from "../lib/database-target"
import { MAX_PROJECT_RECOVERY_SECRETS_BYTES, PROJECT_BACKUP_TABLES, ProjectBackupError, decodeProjectBackup, encodeProjectBackup, projectBackupStorage, projectRecoverySecrets, restoreProjectBackup, validateProjectBackupPayload, type ProjectBackupPayload } from "../lib/project-backup"
import policy from "../deploy/release-policy.json"
import { approvedMigrations } from "../scripts/database/migration-catalog"

const key = Buffer.alloc(32, 57)
const environment = { NODE_ENV: "test" as const, BETTER_AUTH_SECRET: "synthetic-backup-auth-secret-32-characters", PROVIDER_CONFIG_KEY: Buffer.alloc(32, 61).toString("base64"), ASSET_ACCESS_SECRET: "synthetic-backup-asset-secret-32-characters", COS_BUCKET: "synthetic-private-1234567890", COS_REGION: "ap-shanghai" }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`
  return JSON.stringify(value)
}
function payload(): ProjectBackupPayload {
  const value: Omit<ProjectBackupPayload, "contentSha256"> = {
    schema: 1, application: "qintopia-image", database: "qintopia_image", schemaName: "app", createdAt: "2026-10-29T01:00:00.000Z",
    release: { schema: 2, application: "qintopia-image", version: "v0.3.0", revision: "a".repeat(40), platform: "linux/amd64", builtAt: "2026-10-29T00:00:00Z", browserWorkspaceSchema: 1, assetCapabilityVersion: 1, databaseMode: "postgresql", assetAccessProtocol: "account-private-v1", database: policy.database },
    migrations: Object.entries(approvedMigrations).map(([name, sha256]) => ({ name, sha256 })), storage: projectBackupStorage(environment), secrets: projectRecoverySecrets(environment),
    tables: { user: [], account: [], account_audit: [], provider_settings: [], provider_config_audit: [], provider_request_slots: [], creations: [], generation_runs: [], private_assets: [] },
  }
  return { ...value, contentSha256: createHash("sha256").update(canonical(value)).digest("hex") }
}
// 构造具有正确认证、但业务来源/结构错误的输入，证明GCM通过不能代替项目边界。
function sealUntrusted(value: unknown): Buffer {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from("qintopia-image:structured-project-backup:v1"))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return Buffer.from(JSON.stringify({ schema: 1, application: "qintopia-image", algorithm: "aes-256-gcm", nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") }))
}
const configuration = readDatabaseConfiguration("migration", { NODE_ENV: "test", IMAGE_DATABASE_TARGET: "local", IMAGE_MIGRATION_DATABASE_URL: "postgresql://qintopia_image_migrator:synthetic-local-migrator-only@127.0.0.1:32768/qintopia_image" })

test("结构化项目备份认证加密全部内容，不明文泄露密钥，随机nonce且可完整验证", () => {
  const source = payload(), first = encodeProjectBackup(source, key), second = encodeProjectBackup(source, key)
  assert.deepEqual(Object.keys(source.tables).sort(), [...PROJECT_BACKUP_TABLES].sort())
  assert.notDeepEqual(first, second)
  assert.doesNotMatch(first.toString(), /synthetic-backup|BETTER_AUTH_SECRET|PROVIDER_CONFIG_KEY|ASSET_ACCESS_SECRET/)
  assert.deepEqual(decodeProjectBackup(first, key), source)
  const envelope = JSON.parse(first.toString()); envelope.ciphertext = (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1)
  assert.throws(() => decodeProjectBackup(Buffer.from(JSON.stringify(envelope)), key), ProjectBackupError)
  assert.throws(() => decodeProjectBackup(first, Buffer.alloc(32, 58)), ProjectBackupError)
})

test("正确认证但跨项目、额外SQL、错误迁移/摘要/秘密/类型的归档在任何目标查询前拒绝", async () => {
  const changes: Array<(value: any) => void> = [
    value => { value.application = "other-project" }, value => { value.database = "another_database" },
    value => { value.schemaName = "public" }, value => { value.sql = "DROP DATABASE another_database" },
    value => { value.release.sql = "CREATE ROLE unrelated" }, value => { value.release.assetAccessProtocol = "bearer-v1" },
    value => { value.migrations[0].sha256 = "0".repeat(64) }, value => { value.tables.roles = [] },
    value => { value.tables.user = [{ id: "not-a-complete-user" }] }, value => { value.contentSha256 = "f".repeat(64) },
    value => { value.secrets.PROVIDER_CONFIG_KEY = "invalid-key" }, value => { value.storage.prefix = "qintopia-image/releases" },
  ]
  for (const change of changes) {
    const value = structuredClone(payload()); change(value)
    if (value.contentSha256 !== "f".repeat(64)) {
      const { contentSha256: _digest, ...content } = value
      value.contentSha256 = createHash("sha256").update(canonical(content)).digest("hex")
    }
    let queries = 0
    await assert.rejects(restoreProjectBackup({ query: async () => { queries++; return { rows: [] } } }, configuration, sealUntrusted(value), key, projectBackupStorage(environment)), ProjectBackupError)
    assert.equal(queries, 0)
  }
})

test("不同COS桶、错误环境秘密和旧匿名发布身份不能被恢复", async () => {
  const source = payload(), archive = encodeProjectBackup(source, key)
  let queries = 0
  await assert.rejects(restoreProjectBackup({ query: async () => { queries++; return { rows: [] } } }, configuration, archive, key,
    { ...projectBackupStorage(environment), bucket: "different-private-1234567890" }), error => error instanceof ProjectBackupError && error.code === "BACKUP_STORAGE_MISMATCH")
  assert.equal(queries, 0)
  assert.throws(() => projectRecoverySecrets({ ...environment, PROVIDER_CONFIG_KEY: "" }), ProjectBackupError)
  const old = structuredClone(source); old.release.schema = 1
  assert.throws(() => validateProjectBackupPayload(old), ProjectBackupError)
})

test("恢复秘密统一UTF-8输出预算，合法长Unicode可往返，换行值在任何数据库查询前拒绝", async () => {
  const value = payload()
  value.secrets = projectRecoverySecrets({ ...environment, BETTER_AUTH_SECRET: "认证".repeat(2048), ASSET_ACCESS_SECRET: "图片".repeat(2048) })
  const bytes = Buffer.byteLength(JSON.stringify(value.secrets) + "\n")
  assert.ok(bytes > 16_384 && bytes <= MAX_PROJECT_RECOVERY_SECRETS_BYTES)
  const { contentSha256: _digest, ...content } = value
  value.contentSha256 = createHash("sha256").update(canonical(content)).digest("hex")
  assert.deepEqual(decodeProjectBackup(encodeProjectBackup(value, key), key).secrets, value.secrets)
  for (const newline of ["\r", "\n"]) {
    const invalid = structuredClone(value); invalid.secrets.ASSET_ACCESS_SECRET = "valid-secret-at-least-thirty-two-characters" + newline
    const { contentSha256: _old, ...body } = invalid
    invalid.contentSha256 = createHash("sha256").update(canonical(body)).digest("hex")
    let queries = 0
    await assert.rejects(restoreProjectBackup({ query: async () => { queries++; return { rows: [] } } }, configuration, sealUntrusted(invalid), key, projectBackupStorage(environment)), ProjectBackupError)
    assert.equal(queries, 0)
  }
})
