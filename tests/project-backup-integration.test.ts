import assert from "node:assert/strict"
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import sharp from "sharp"
import { bootstrapAdministrator, changePassword, createAccount, manageAccount } from "../lib/auth/accounts"
import { handleAuthRequest } from "../lib/auth/http"
import { accountIdentity } from "../lib/auth/guards"
import { AccountError } from "../lib/auth/errors"
import { closeDatabase, createMaintenanceDatabasePool, getDatabase } from "../lib/database"
import { readDatabaseConfiguration } from "../lib/database-target"
import { executePrivateGeneration, readVerifiedPrivateAsset } from "../lib/private-generation"
import { bytesHash, parsePrivateGenerationForm } from "../lib/private-generation-input"
import { acceptPrivateRun, createPrivateCreation, listPrivateCreations, readPrivateAsset, readPrivateRun } from "../lib/private-workspace-service"
import { readAdminProvider, recordAdminAnnotationCapability, saveAdminProvider } from "../lib/provider-configuration"
import { validateAnnotationSnapshot, type AnnotationSnapshot } from "../lib/image-annotations"
import { decryptProviderSecret } from "../lib/provider-secret"
import { PROJECT_BACKUP_TABLES, ProjectBackupError, decodeProjectBackup, exportProjectBackup, preflightProjectRestore, projectBackupStorage, projectRecoverySecrets, restoreProjectBackup, verifyRestoredProjectBackup, type ProjectBackupPayload } from "../lib/project-backup"
import { assertAccountTestFixture } from "../scripts/database/test-fixture"
import policy from "../deploy/release-policy.json"
import type { PrivateCosStore } from "../lib/private-cos"

const fixtureUrl = process.env.IMAGE_BACKUP_TEST_DATABASE_URL
if (fixtureUrl !== "postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image") throw new Error("Backup integration requires the exact existing local synthetic fixture")
Object.assign(process.env, {
  IMAGE_DATABASE_TARGET: "local", IMAGE_DATABASE_URL: fixtureUrl,
  IMAGE_MIGRATION_DATABASE_URL: "postgresql://qintopia_image_migrator:synthetic-local-migrator-only@127.0.0.1:32768/qintopia_image",
  NODE_ENV: "test", BETTER_AUTH_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "synthetic-backup-auth-secret-32-characters",
  PROVIDER_CONFIG_KEY: Buffer.alloc(32, 61).toString("base64"), ASSET_ACCESS_SECRET: "synthetic-backup-asset-secret-32-characters",
  COS_BUCKET: "synthetic-private-1234567890", COS_REGION: "ap-shanghai", IMAGE_GENERATION_MAX_CONCURRENT: "8", IMAGE_GENERATION_PER_USER_CONCURRENT: "8", IMAGE_GENERATION_RATE_PER_MINUTE: "60",
})
const password = "Synthetic-backup-password-20261030", names = ["provider-admin-a", "provider-user", "provider-temp"]
const key = Buffer.alloc(32, 57), storage = projectBackupStorage(process.env), secrets = projectRecoverySecrets(process.env)
const bundledCli = process.env.IMAGE_BACKUP_BUNDLED_CLI
if (bundledCli && (!path.isAbsolute(bundledCli) || !bundledCli.endsWith("/maintenance/cli.mjs"))) throw new Error("Expected the absolute extracted maintenance CLI")
function executeBundle(command: string, input?: Buffer) {
  assert.ok(bundledCli)
  const directory = mkdtempSync(path.join(tmpdir(), "image-backup-bundle-")), descriptors: number[] = []
  try {
    const inputPath = path.join(directory, "input"), outputPath = path.join(directory, "secrets")
    writeFileSync(inputPath, input ?? Buffer.alloc(0), { mode: 0o600, flag: "wx" })
    const fd3 = openSync(inputPath, command === "backup" ? "r+" : "r"); descriptors.push(fd3)
    const bootstrap = command === "bootstrap-admin" || command === "verify-bootstrap-admin"
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test", IMAGE_DATABASE_TARGET: "local", IMAGE_DATABASE_URL: fixtureUrl }
    if (!bootstrap) Object.assign(environment, {
      IMAGE_MIGRATION_DATABASE_URL: process.env.IMAGE_MIGRATION_DATABASE_URL, BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
      ...secrets, COS_BUCKET: storage.bucket, COS_REGION: storage.region, IMAGE_RECOVERY_KEY: key.toString("base64"),
    })
    const outputSecrets = command === "restore" || command === "verify-restore"
    const fd4 = outputSecrets ? openSync(outputPath, "wx+", 0o600) : undefined
    if (fd4 !== undefined) descriptors.push(fd4)
    const result = spawnSync(process.execPath, [bundledCli, command], { cwd: path.dirname(path.dirname(bundledCli)), env: environment,
      encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe", fd3, ...(fd4 === undefined ? [] : [fd4])] })
    assert.equal(result.status, 0, `packaged ${command}: ${result.stdout} ${result.stderr}`)
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-backup-provider-token|Synthetic-backup-password|BETTER_AUTH_SECRET|PROVIDER_CONFIG_KEY|ASSET_ACCESS_SECRET/)
    const status = JSON.parse(result.stdout)
    assert.equal(status.application, "qintopia-image"); assert.equal(status.command, command)
    const prepared = outputSecrets ? readFileSync(outputPath) : undefined
    if (status.notRestored) assert.equal(prepared?.length, 0)
    return { status, archive: command === "backup" ? readFileSync(inputPath) : undefined,
      secrets: prepared?.length ? JSON.parse(prepared.toString("utf8")) : undefined }
  } finally { for (const fd of descriptors) closeSync(fd); rmSync(directory, { recursive: true, force: true }) }
}
const release = { schema: 2, application: "qintopia-image", version: "v0.3.0", revision: "b".repeat(40), platform: "linux/amd64", builtAt: "2026-10-29T00:00:00Z", browserWorkspaceSchema: 2, assetCapabilityVersion: 1, databaseMode: "postgresql", assetAccessProtocol: "account-private-v1", database: policy.database }
async function login(username: string, value = password): Promise<Headers> {
  const response = await handleAuthRequest(new Request("http://localhost:3000/api/auth/sign-in/username", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ username, password: value }) }))
  assert.equal(response.status, 200, await response.clone().text())
  return new Headers({ cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") })
}
const code = (expected: string) => (error: unknown) => (error instanceof ProjectBackupError || error instanceof AccountError) && error.code === expected
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`).join(",")}}`
  return JSON.stringify(value)
}
function authenticatedInvalidArchive(payload: ProjectBackupPayload, change: (value: ProjectBackupPayload) => void): Buffer {
  const value = structuredClone(payload); change(value)
  const { contentSha256: _digest, ...content } = value
  value.contentSha256 = createHash("sha256").update(canonical(content)).digest("hex")
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from("qintopia-image:structured-project-backup:v1"))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return Buffer.from(JSON.stringify({ schema: 1, application: "qintopia-image", algorithm: "aes-256-gcm", nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") }))
}

test("真实专用PG：三账号、原图和文档、认证备份、空目标恢复及丢回执核对", { concurrency: false, timeout: 60_000 }, async t => {
  const runtime = await getDatabase(), migration = createMaintenanceDatabasePool("migration")
  const configuration = readDatabaseConfiguration("migration")
  async function cleanup() {
    await assertAccountTestFixture(runtime)
    const ids = 'SELECT id FROM app."user" WHERE username=ANY($1::text[])'
    await runtime.query('DELETE FROM app.provider_config_audit WHERE "actorId" IN (' + ids + ')', [names])
    await runtime.query('DELETE FROM app.provider_settings WHERE "updatedBy" IN (' + ids + ')', [names])
    await runtime.query('DELETE FROM app.account_audit WHERE "actorId" IN (' + ids + ') OR "subjectId" IN (' + ids + ')', [names])
    await runtime.query('DELETE FROM app."user" WHERE username=ANY($1::text[])', [names])
  }
  t.after(async () => { try { await cleanup() } finally { await migration.end(); await closeDatabase() } })
  await cleanup()
  const administrator = { username: names[0], name: "合成恢复管理员", password }
  if (bundledCli) {
    const input = Buffer.from(JSON.stringify(administrator))
    const created = executeBundle("bootstrap-admin", input).status
    assert.equal(created.initialized, true)
    const verified = executeBundle("verify-bootstrap-admin", input).status
    assert.equal(verified.verified, true); assert.equal(verified.administratorId, created.administratorId)
  } else await bootstrapAdministrator(administrator)
  const adminHeaders = await login(names[0])
  const userHeaders: Headers[] = []
  for (const username of names.slice(1)) {
    const created = await createAccount(adminHeaders, { username, name: `合成恢复用户 ${username}` })
    const temporary = await login(username, created.temporaryPassword)
    await changePassword(temporary, { currentPassword: created.temporaryPassword, newPassword: password })
    userHeaders.push(await login(username))
  }
  await saveAdminProvider(adminHeaders, { revision: 0, settings: { baseUrl: "https://synthetic-backup.example/v1", apiKey: "synthetic-backup-provider-token", apiMode: "images" }, models: [], mappings: [{ id: "mapping-backup", name: "合成恢复模型", modelId: "synthetic-model" }], modelsSynced: false })
  const configurationRevision = (await recordAdminAnnotationCapability(adminHeaders, { revision: 1, mappingId: "mapping-backup",
    evidenceReference: "https://synthetic-backup.example/input-contract", evidenceNote: "合成恢复夹具确认两张输入，不代表真实模型效果。", confirmed: true })).revision
  const identities = await Promise.all(userHeaders.map(headers => accountIdentity(headers)))
  const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>()
  const store: PrivateCosStore = {
    put: async (key, bytes, mediaType) => { objects.set(key, { bytes: Buffer.from(bytes), mediaType }) },
    get: async (key, maximum) => { const found = objects.get(key); assert.ok(found && found.bytes.length <= maximum); return found },
  }
  let modelCalls = 0
  const inputHashes: string[][] = []
  const generate = async (_settings: unknown, input: { images: { bytes: Uint8Array }[] }) => {
    inputHashes.push(input.images.map(image => bytesHash(image.bytes))); modelCalls++
    const png = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 20 * modelCalls, g: 100, b: 180 } } }).png().toBuffer()
    return { bytes: png, mediaType: "image/png" }
  }
  const creationIds = [randomUUID(), randomUUID()]
  async function input(owner: number, parent?: string, document = false, annotationSnapshot?: AnnotationSnapshot) {
    const form = new FormData()
    for (const [name, value] of Object.entries({ creationId: creationIds[owner], clientRequestId: randomUUID(), mappingId: "mapping-backup", configRevision: String(configurationRevision), prompt: "合成恢复演练：保留主体", aspectRatio: "square", quality: "auto", mode: parent ? "image-editing" : "text-to-image" })) form.set(name, value)
    if (parent) form.set("parentVersionId", parent)
    if (document) form.set("document", new File(["需要恢复的合成文档"], "合成恢复.txt", { type: "text/plain" }))
    if (annotationSnapshot) form.set("annotationSnapshot", JSON.stringify(annotationSnapshot))
    return parsePrivateGenerationForm(form)
  }
  const first = await executePrivateGeneration(identities[0], await input(0), undefined, { store, generate })
  const annotationSnapshot = validateAnnotationSnapshot({ schema: 1, coordinateSpace: "encoded-pixels-v1", baseVersionId: first.id,
    image: { assetId: first.imageUrl!.split("/").at(-1)!, width: 96, height: 64, orientation: 1, pages: 1 },
    marks: [{ id: randomUUID(), number: 3, instruction: "将选区改成暖色，保留主体", geometry: { type: "rectangle", x: 10, y: 8, width: 30, height: 24 } }] })
  const second = await executePrivateGeneration(identities[0], await input(0, first.id, true, annotationSnapshot), undefined, { store, generate })
  const other = await executePrivateGeneration(identities[1], await input(1), undefined, { store, generate })
  assert.equal(first.status, "complete"); assert.equal(second.status, "complete"); assert.equal(other.status, "complete")
  const assetId = first.imageUrl!.split("/").at(-1)!
  const firstAsset = await readPrivateAsset(identities[0], assetId, "image")
  assert.equal(inputHashes[1][0], bytesHash((await readVerifiedPrivateAsset(firstAsset, store)).bytes))
  assert.equal(inputHashes[1].length, 2)
  assert.deepEqual(second.annotationSnapshot, annotationSnapshot)
  await assert.rejects(readPrivateAsset(identities[1], assetId, "image"), code("NOT_FOUND"))
  await assert.rejects(readPrivateAsset(await accountIdentity(adminHeaders), assetId, "image"), code("NOT_FOUND"))
  const pendingInput = await input(0, first.id)
  await acceptPrivateRun(identities[0], pendingInput.command)
  // 让归档中真实存在一份尚未兑换的临时凭证，恢复后必须无法登录。
  const testedTemporary = await manageAccount(adminHeaders, identities[1].user.id, { action: "reset-password" })
  await login(names[2], testedTemporary.temporaryPassword!)
  // 登录会兑换临时凭据；另发一份未使用的凭据，才可证明恢复过程主动使其失效。
  const resetBeforeBackup = await manageAccount(adminHeaders, identities[1].user.id, { action: "reset-password" })
  const temporaryBeforeBackup = resetBeforeBackup.temporaryPassword!
  assert.notEqual(temporaryBeforeBackup, testedTemporary.temporaryPassword)
  const bulkCreationIds = Array.from({ length: 205 }, () => randomUUID())
  await runtime.query('INSERT INTO app.creations ("ownerId",id,title) SELECT $1,value,\'合成批量恢复创作\' FROM unnest($2::uuid[]) AS value', [identities[0].user.id, bulkCreationIds])
  const client = await migration.connect()
  try {
    await createPrivateCreation(adminHeaders, { id: "00000000-0000-0000-0000-000000000000", title: "已有合法UUID空创作" })
    const archive = bundledCli ? executeBundle("backup").archive! : await exportProjectBackup(client, configuration, release, secrets, key, storage)
    const payload = decodeProjectBackup(archive, key)
    assert.equal(payload.tables.user.length, 3); assert.equal(payload.tables.generation_runs.length, 4)
    const annotatedVersion = payload.tables.generation_runs.find(row => row.id === second.id)!
    assert.deepEqual(annotatedVersion.annotationSnapshot, annotationSnapshot)
    assert.ok(annotatedVersion.annotationExecution)
    const temporaryAccount = payload.tables.user.find(row => row.id === identities[1].user.id)!
    assert.equal(temporaryAccount.mustChangePassword, true)
    assert.equal(temporaryAccount.temporaryPasswordUsedAt, null)
    assert.ok(Date.parse(String(temporaryAccount.temporaryPasswordExpiresAt)) > Date.parse(payload.createdAt))
    assert.ok(payload.tables.creations.some(row => row.id === "00000000-0000-0000-0000-000000000000"))
    assert.equal(payload.tables.creations.length, 208)
    const assertVerified = async () => assert.deepEqual(await verifyRestoredProjectBackup(client, configuration, archive, key, storage), {
      verified: true, contentSha256: payload.contentSha256, rowCount: Object.values(payload.tables).reduce((sum, rows) => sum + rows.length, 0),
    })
    assert.equal("session" in payload.tables, false)
    const corruptions: Array<(value: ProjectBackupPayload) => void> = [
      value => { const row = value.tables.private_assets[0]; row.key = String(row.key).replace(/private\/v1\/[0-9a-f]{64}/, `private/v1/${"0".repeat(64)}`) },
      value => { value.tables.private_assets.find(row => row.runId === first.id)!.runId = other.id },
      value => { value.secrets.PROVIDER_CONFIG_KEY = Buffer.alloc(32, 63).toString("base64") },
      value => { (value.tables.generation_runs.find(row => row.id === second.id)!.annotationSnapshot as AnnotationSnapshot).marks[0].instruction = "篡改快照" },
      value => { (value.tables.generation_runs.find(row => row.id === second.id)!.annotationExecution as any).inputs[1].sha256 = "0".repeat(64) },
      value => { (value.tables.provider_settings[0].annotationCapabilities as any[])[0].evidence.note = "篡改能力证据" },
      value => { (value.tables.provider_settings[0].annotationCapabilities as any[])[0].evidence.actorId = identities[0].user.id },
    ]
    for (const change of corruptions) {
      let queries = 0
      const untouched = { query: async () => { queries++; return { rows: [] } } }
      const invalid = authenticatedInvalidArchive(payload, change)
      await assert.rejects(restoreProjectBackup(untouched, configuration, invalid, key, storage), ProjectBackupError)
      await assert.rejects(preflightProjectRestore(untouched, configuration, invalid, key, storage), ProjectBackupError)
      assert.equal(queries, 0)
    }
    let driftMutation = false
    const driftedLedger = { query: async (sql: string, values?: unknown[]) => {
      if (/^(?:BEGIN|LOCK|INSERT|UPDATE|DELETE)/.test(sql.trim()) || sql.includes("pg_advisory")) driftMutation = true
      const result = await client.query(sql, values)
      if (sql.includes("SELECT version, name, sha256 FROM app.schema_migrations")) return { ...result, rows: result.rows.map(row => ({ ...row, version: "9999" })) }
      return result
    } }
    await assert.rejects(restoreProjectBackup(driftedLedger, configuration, archive, key, storage), code("BACKUP_MIGRATION_MISMATCH"))
    assert.equal(driftMutation, false)
    await assert.rejects(restoreProjectBackup(client, configuration, archive, key, storage), code("BACKUP_TARGET_NOT_EMPTY"))
    await assert.rejects(preflightProjectRestore(client, configuration, archive, key, storage), code("BACKUP_TARGET_NOT_EMPTY"))
    await assert.rejects(verifyRestoredProjectBackup(client, configuration, archive, key, storage), code("BACKUP_RESTORE_MISMATCH"))
    await cleanup()
    const assertEmpty = async () => {
      for (const table of PROJECT_BACKUP_TABLES) assert.equal((await client.query(`SELECT count(*)::integer AS count FROM app."${table}"`)).rows[0].count, 0, table)
    }
    assert.equal((await preflightProjectRestore(client, configuration, archive, key, storage)).ready, true)
    await assertEmpty()
    let insertCount = 0
    const interruptedInsert = { query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith("INSERT INTO") && ++insertCount === 5) throw new Error("synthetic interrupted restore insert")
      return client.query(sql, values)
    } }
    await assert.rejects(restoreProjectBackup(interruptedInsert, configuration, archive, key, storage), code("BACKUP_RESTORE_FAILED"))
    assert.equal(insertCount, 5); await assertEmpty()
    const missingCommit = { query: async (sql: string, values?: unknown[]) => {
      if (sql === "COMMIT") throw new Error("synthetic COMMIT never reached the database")
      return client.query(sql, values)
    } }
    await assert.rejects(restoreProjectBackup(missingCommit, configuration, archive, key, storage), code("BACKUP_RESTORE_UNCONFIRMED"))
    assert.deepEqual(await verifyRestoredProjectBackup(client, configuration, archive, key, storage), { notRestored: true, contentSha256: payload.contentSha256, rowCount: 0 })
    if (bundledCli) {
      const empty = executeBundle("verify-restore", archive)
      assert.equal(empty.status.notRestored, true); assert.equal(empty.status.secretsPrepared, false); assert.equal(empty.secrets, undefined)
    }
    await assertEmpty()
    let restored: { secrets: typeof secrets }
    if (bundledCli) {
      assert.equal(executeBundle("restore-preflight", archive).status.ready, true)
      const result = executeBundle("restore", archive)
      assert.equal(result.status.restored, true)
      restored = result
      const verified = executeBundle("verify-restore", archive)
      assert.equal(verified.status.verified, true); assert.deepEqual(verified.secrets, secrets)
    } else restored = await restoreProjectBackup(client, configuration, archive, key, storage)
    assert.deepEqual(restored.secrets, secrets)
    await assertVerified()
    await assert.rejects(accountIdentity(userHeaders[0]), code("UNAUTHENTICATED"))
    assert.equal((await runtime.query('SELECT count(*)::integer AS count FROM app.session')).rows[0].count, 0)
    const stored = (await runtime.query('SELECT "tokenCiphertext" FROM app.provider_settings')).rows[0]
    assert.throws(() => decryptProviderSecret(stored.tokenCiphertext, { PROVIDER_CONFIG_KEY: Buffer.alloc(32, 63).toString("base64") }))
    assert.equal(decryptProviderSecret(stored.tokenCiphertext, restored.secrets), "synthetic-backup-provider-token")

    // 模拟数据库已经提交，但维护进程没有收到COMMIT回执；只读核对不重放写入。
    await cleanup()
    const lostReceipt = { query: async (sql: string, values?: unknown[]) => { const result = await client.query(sql, values); if (sql === "COMMIT") throw new Error("synthetic lost receipt"); return result } }
    await assert.rejects(restoreProjectBackup(lostReceipt, configuration, archive, key, storage), code("BACKUP_RESTORE_UNCONFIRMED"))
    await assertVerified()
    const refusedTemporary = await handleAuthRequest(new Request("http://localhost:3000/api/auth/sign-in/username", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ username: names[2], password: temporaryBeforeBackup }) }))
    assert.equal(refusedTemporary.status, 401)
    assert.equal((await runtime.query('SELECT count(*)::integer AS count FROM app.session WHERE "userId"=$1', [identities[1].user.id])).rows[0].count, 0)
    const restoredAdmin = await login(names[0]), restoredUser = await login(names[1])
    const freshTemporary = await manageAccount(restoredAdmin, identities[1].user.id, { action: "reset-password" })
    const freshHeaders = await login(names[2], freshTemporary.temporaryPassword!)
    await changePassword(freshHeaders, { currentPassword: freshTemporary.temporaryPassword!, newPassword: password })
    const restoredOther = await login(names[2])
    assert.equal((await listPrivateCreations(restoredAdmin))[0].id, "00000000-0000-0000-0000-000000000000")
    const recovered = await accountIdentity(restoredUser)
    const recoveredAnnotation = await readPrivateRun(recovered, second.id)
    assert.deepEqual(recoveredAnnotation.public.annotationSnapshot, annotationSnapshot)
    assert.deepEqual(recoveredAnnotation.annotationExecution, annotatedVersion.annotationExecution)
    assert.equal((await listPrivateCreations(restoredUser)).find(creation => creation.id === creationIds[0])!.versions.length, 3)
    assert.equal((await runtime.query('SELECT count(*)::integer AS count FROM app.creations WHERE id=ANY($1::uuid[])', [bulkCreationIds])).rows[0].count, bulkCreationIds.length)
    assert.equal((await listPrivateCreations(restoredOther))[0].versions.length, 1)
    assert.equal((await readPrivateRun(recovered, pendingInput.command.clientRequestId)).public.status, "unknown")
    const restoredAsset = await readPrivateAsset(recovered, assetId, "image")
    assert.deepEqual(await readVerifiedPrivateAsset(restoredAsset, store), await readVerifiedPrivateAsset(firstAsset, store))
    const doc = await readPrivateAsset(recovered, second.document!.assetId, "document")
    assert.equal(Buffer.from((await readVerifiedPrivateAsset(doc, store)).bytes).toString(), "需要恢复的合成文档")
    assert.equal((await readAdminProvider(restoredAdmin)).secretConfigured, true)
    await manageAccount(restoredAdmin, recovered.user.id, { action: "disable" })
    await assert.rejects(accountIdentity(restoredUser), code("UNAUTHENTICATED"))
    assert.equal(modelCalls, 3)
    console.log(JSON.stringify({ projectRecovery: "passed", accounts: 3, annotationSnapshotRestored: true, simulatedModelCalls: modelCalls, realModelCalls: 0, cloudWrites: 0, oldSessionsRestored: 0, temporaryPasswordRevoked: true, bulkCreationsRestored: bulkCreationIds.length, commitReceiptLoss: "verified-read-only", packagedCli: Boolean(bundledCli) }))
  } finally { client.release() }
})
