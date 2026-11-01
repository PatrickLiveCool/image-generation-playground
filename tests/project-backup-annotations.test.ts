import assert from "node:assert/strict"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { test } from "node:test"
import { readDatabaseConfiguration } from "../lib/database-target"
import { serializeAnnotationCapabilityBinding, serializeAnnotationCapabilityEvidence, type StoredAnnotationCapability } from "../lib/annotation-capability"
import { validateAnnotationExecution } from "../lib/annotation-execution"
import { serializeAnnotationSnapshot, validateAnnotationSnapshot } from "../lib/image-annotations"
import { encryptProviderSecret } from "../lib/provider-secret"
import { decodeProjectBackup, encodeProjectBackup, preflightProjectRestore, PROJECT_BACKUP_TABLES, projectBackupStorage, projectRecoverySecrets, ProjectBackupError, restoreProjectBackup, validateProjectBackupPayload, type ProjectBackupPayload } from "../lib/project-backup"
import policy from "../deploy/release-policy.json"

const key = Buffer.alloc(32, 51)
const environment = { NODE_ENV: "test" as const, BETTER_AUTH_SECRET: "synthetic-annotation-backup-auth-secret", PROVIDER_CONFIG_KEY: Buffer.alloc(32, 61).toString("base64"),
  ASSET_ACCESS_SECRET: "synthetic-annotation-backup-asset-secret", COS_BUCKET: "synthetic-private-1234567890", COS_REGION: "ap-shanghai" }
const migration = readDatabaseConfiguration("migration", { NODE_ENV: "test", IMAGE_DATABASE_TARGET: "local", IMAGE_MIGRATION_DATABASE_URL: "postgresql://qintopia_image_migrator:synthetic-local-migrator-only@127.0.0.1:32768/qintopia_image" })
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`).join(",")}}`
  return JSON.stringify(value)
}
function resigned(value: ProjectBackupPayload): ProjectBackupPayload {
  const { contentSha256: _digest, ...content } = value
  return { ...content, contentSha256: sha(canonical(content)) }
}
const creation = "10000000-0000-4000-8000-000000000001", first = "20000000-0000-4000-8000-000000000001", second = "20000000-0000-4000-8000-000000000002"
const originalId = "30000000-0000-4000-8000-000000000001", outputId = "30000000-0000-4000-8000-000000000002"
const inputIds = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"]
const owner = "synthetic-backup-user", admin = "synthetic-backup-admin", now = "2026-10-29T00:00:00.000Z", deadline = "2026-10-29T00:05:00.000Z"
const prefix = (run: string) => `image-playground/private/v1/${sha(owner)}/${creation}/${run}`
const token = "synthetic-annotation-provider-token", baseUrl = "https://synthetic.example/v1"
function fixture(): ProjectBackupPayload {
  const capability: StoredAnnotationCapability = { expression: "overlay-v1", maxInputImages: 2, configurationRevision: 3, mappingId: "mapping-a",
    bindingSha256: sha(serializeAnnotationCapabilityBinding({ baseUrl, apiMode: "images", modelId: "synthetic-model", tokenSha256: sha(`qintopia-image:annotation-token:v1\0${token}`) })),
    evidenceSha256: "0".repeat(64), evidence: { id: "50000000-0000-4000-8000-000000000001", actorId: admin, recordedAt: now, reference: "https://synthetic.example/evidence", note: "合成输入契约证据，不代表真实效果。", confirmed: true } }
  capability.evidenceSha256 = sha(serializeAnnotationCapabilityEvidence(capability))
  const { mappingId: _mapping, evidence: _evidence, ...resolved } = capability
  const frozen = { ...resolved, configurationRevision: 2 }
  const snapshot = validateAnnotationSnapshot({ schema: 1, coordinateSpace: "encoded-pixels-v1", baseVersionId: first,
    image: { assetId: originalId, width: 96, height: 64, orientation: 6, pages: 1 }, marks: [{ id: "60000000-0000-4000-8000-000000000001", number: 7, instruction: "保留主体，选区换成暖色", geometry: { type: "rectangle", x: 4, y: 5, width: 20, height: 30 } }] })
  const execution = validateAnnotationExecution({ schema: 1, expression: "overlay-v1", renderVersion: 1, snapshotSha256: sha(serializeAnnotationSnapshot(snapshot)),
    original: { ...snapshot.image, sha256: "a".repeat(64), byteLength: 10 }, capability: frozen,
    inputs: [{ role: "original", id: inputIds[0], key: `${prefix(second)}/inputs/reference-1`, sha256: "a".repeat(64), byteLength: 10 },
      { role: "overlay", id: inputIds[1], key: `${prefix(second)}/inputs/reference-2`, sha256: "b".repeat(64), byteLength: 20 }] })
  const user = (id: string, username: string, role: string, banned: boolean) => ({ id, username, name: username, email: `${username}@synthetic.invalid`, emailVerified: false, image: null,
    createdAt: now, updatedAt: now, displayUsername: null, role, banned, banReason: null, banExpires: null, mustChangePassword: false, temporaryPasswordExpiresAt: null, temporaryPasswordUsedAt: null })
  const run = (id: string, version: number, output: string) => ({ ownerId: owner, id, creationId: creation, clientRequestId: id, fingerprint: "f".repeat(64), version,
    parentVersionId: version === 1 ? null : first, status: "complete", prompt: "保留主体", mappingId: "mapping-a", modelLabel: "合成映射", aspectRatio: "square", quality: "auto", mode: version === 1 ? "text-to-image" : "image-editing",
    providerBaseUrl: baseUrl, providerApiMode: "images", providerModelId: "synthetic-model", providerRevision: 2,
    manifestKey: `${prefix(id)}/manifest.json`, outputKey: `${prefix(id)}/outputs/final`, outputAssetId: output, failureCode: null, createdAt: now, updatedAt: now, deadlineAt: deadline,
    annotationSnapshot: version === 1 ? null : snapshot, annotationExecution: version === 1 ? null : execution, providerAnnotationCapability: version === 1 ? null : frozen })
  const asset = (runId: string, id: string, suffix: string, sha256: string, byteLength: number, mediaType = "image/png") => ({ ownerId: owner, id, creationId: creation, runId, key: `${prefix(runId)}/${suffix}`, kind: "image", mediaType, byteLength, sha256, name: null, createdAt: now })
  return resigned({ schema: 1, application: "qintopia-image", database: "qintopia_image", schemaName: "app", createdAt: now,
    release: { schema: 2, application: "qintopia-image", version: "v0.3.0", revision: "a".repeat(40), platform: "linux/amd64", builtAt: now,
      browserWorkspaceSchema: 2, assetCapabilityVersion: 1, databaseMode: "postgresql", assetAccessProtocol: "account-private-v1", database: policy.database },
    migrations: policy.database.migrations, storage: projectBackupStorage(environment), secrets: projectRecoverySecrets(environment), contentSha256: "0".repeat(64),
    tables: { user: [user(admin, "backup-admin", "admin", true), user(owner, "backup-user", "user", false)], account: [], account_audit: [], provider_config_audit: [],
      provider_settings: [{ singleton: 1, baseUrl, tokenCiphertext: encryptProviderSecret(token, environment), apiMode: "images", models: [], mappings: [{ id: "mapping-a", name: "新显示名称", modelId: "synthetic-model" }], modelsSynced: false,
        revision: 3, updatedBy: admin, updatedAt: now, annotationCapabilities: [capability] }],
      provider_request_slots: [first, second].map(requestId => ({ userId: owner, requestId, fingerprint: "f".repeat(64), status: "finished", acceptedAt: now, deadlineAt: deadline })),
      creations: [{ ownerId: owner, id: creation, title: "合成批注恢复", revision: 1, nextVersion: 3, createdAt: now, updatedAt: now }],
      generation_runs: [run(first, 1, originalId), run(second, 2, outputId)],
      private_assets: [asset(first, originalId, "outputs/final", "a".repeat(64), 10), asset(second, inputIds[0], "inputs/reference-1", "a".repeat(64), 10),
        asset(second, inputIds[1], "inputs/reference-2", "b".repeat(64), 20), asset(second, outputId, "outputs/final", "c".repeat(64), 30)] },
  })
}
function seal(value: ProjectBackupPayload): Buffer {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from("qintopia-image:structured-project-backup:v1"))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(resigned(value))), cipher.final()])
  return Buffer.from(JSON.stringify({ schema: 1, application: "qintopia-image", algorithm: "aes-256-gcm", nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") }))
}

test("批注快照/冻结输入与禁用管理员证据可完整备份，历史能力不按当前revision重判", () => {
  const payload = fixture()
  assert.deepEqual(Object.keys(payload.tables).sort(), [...PROJECT_BACKUP_TABLES].sort())
  assert.deepEqual(decodeProjectBackup(encodeProjectBackup(payload, key), key), payload)
  assert.equal(payload.tables.generation_runs[0].annotationSnapshot, null)
  const jpeg = fixture(); jpeg.tables.private_assets[2].mediaType = "image/jpeg"
  assert.deepEqual(decodeProjectBackup(encodeProjectBackup(resigned(jpeg), key), key), resigned(jpeg))
  // 当前连接重新绑定后旧版本依旧使用受理时冻结的能力，不要求匹配当前证据。
  const rebound = fixture(); rebound.tables.provider_settings[0].annotationCapabilities = []
  rebound.tables.provider_settings[0].baseUrl = "https://another-synthetic.example/v1"
  assert.doesNotThrow(() => encodeProjectBackup(resigned(rebound), key))
})

test("既有能力证据的记录者降为user后仍可备份，原能力和证据摘要保持不变", () => {
  const original = fixture()
  const existing = decodeProjectBackup(encodeProjectBackup(original, key), key)
  const capabilities = structuredClone(existing.tables.provider_settings[0].annotationCapabilities)
  existing.tables.user.find(user => user.id === admin)!.role = "user"
  // 只改变账号的当前角色与归档整体摘要，绝不重建能力或重新签署证据。
  const restored = decodeProjectBackup(encodeProjectBackup(resigned(existing), key), key)
  assert.equal(restored.tables.user.find(user => user.id === admin)!.role, "user")
  assert.deepEqual(restored.tables.provider_settings[0].annotationCapabilities, capabilities)
  assert.deepEqual(restored.tables.generation_runs, original.tables.generation_runs)
})

test("准备中、失败和恢复后的unknown允许未冻结execution；已调用模型阶段必须冻结", () => {
  for (const status of ["preparing", "unknown", "failed"]) {
    const value = fixture(), run = value.tables.generation_runs[1]
    run.status = status; run.annotationExecution = null; run.failureCode = "ANNOTATION_INPUT_INVALID"
    value.tables.private_assets = value.tables.private_assets.filter(asset => asset.runId !== second)
    const result = decodeProjectBackup(encodeProjectBackup(resigned(value), key), key)
    assert.equal(result.tables.generation_runs[1].annotationExecution, null)
    assert.equal(result.tables.generation_runs[1].failureCode, "ANNOTATION_INPUT_INVALID")
  }
})

test("认证正确但批注来源、执行绑定或能力证据被篡改时，恢复和预检在任何目标查询前拒绝", async () => {
  const mutations: Array<(value: any) => void> = [
    p => { p.tables.generation_runs[1].annotationSnapshot.baseVersionId = second },
    p => { p.tables.generation_runs[1].annotationSnapshot.image.assetId = outputId },
    p => { p.tables.generation_runs[1].annotationSnapshot.marks[0].instruction = "篡改说明" },
    p => { p.tables.generation_runs[1].annotationSnapshot.marks[0].geometry.width = 999 },
    p => { p.tables.generation_runs[1].annotationExecution = null },
    p => { p.tables.generation_runs[1].providerAnnotationCapability = null },
    p => { p.tables.generation_runs[0].annotationExecution = p.tables.generation_runs[1].annotationExecution },
    p => { p.tables.generation_runs[1].annotationExecution.original.sha256 = "d".repeat(64); p.tables.generation_runs[1].annotationExecution.inputs[0].sha256 = "d".repeat(64) },
    p => { p.tables.generation_runs[1].annotationExecution.original.orientation = 1 },
    p => { p.tables.generation_runs[1].annotationExecution.inputs[1].id = outputId },
    p => { p.tables.generation_runs[1].annotationExecution.inputs[1].sha256 = "d".repeat(64) },
    p => { p.tables.generation_runs[1].annotationExecution.inputs.reverse() },
    p => { p.tables.generation_runs[1].annotationExecution.inputs.forEach((i: any) => { i.key = i.key.replace(second, first) }) },
    p => { p.tables.generation_runs[1].annotationExecution.capability.bindingSha256 = "d".repeat(64) },
    p => { p.tables.generation_runs[1].providerRevision = 4 },
    p => { p.tables.private_assets[0].ownerId = admin },
    p => { p.tables.private_assets[2].mediaType = "image/gif" },
    p => { p.tables.private_assets.splice(2, 1) },
    p => { p.tables.provider_settings[0].annotationCapabilities[0].configurationRevision = 2 },
    p => { p.tables.provider_settings[0].annotationCapabilities[0].mappingId = "missing-mapping" },
    p => { p.tables.provider_settings[0].annotationCapabilities[0].evidence.actorId = owner },
    p => { p.tables.provider_settings[0].annotationCapabilities[0].evidence.note = "篡改证据" },
    p => { p.tables.provider_settings[0].annotationCapabilities[0].evidenceSha256 = "d".repeat(64) },
    p => { p.tables.provider_settings[0].tokenCiphertext = encryptProviderSecret("changed-token", environment) },
    p => { p.tables.provider_settings[0].mappings[0].modelId = "different-model" },
    p => { p.release.browserWorkspaceSchema = 1 },
  ]
  for (const mutate of mutations) {
    const value = fixture(); mutate(value); const bytes = seal(value)
    assert.throws(() => validateProjectBackupPayload(resigned(value)), error => error instanceof ProjectBackupError && error.code !== "BACKUP_DIGEST_INVALID")
    let queries = 0
    const client = { query: async () => { queries++; return { rows: [] } } }
    await assert.rejects(restoreProjectBackup(client, migration, bytes, key, value.storage), ProjectBackupError)
    await assert.rejects(preflightProjectRestore(client, migration, bytes, key, value.storage), ProjectBackupError)
    assert.equal(queries, 0)
  }
})


test("原图可达20MiB而辅助图仍限10MiB；有模型结果阶段缺冻结记录必须拒绝", () => {
  const value = fixture(), run = value.tables.generation_runs[1]
  const bytes = 11 * 1024 * 1024
  value.tables.private_assets[0].byteLength = bytes
  value.tables.private_assets[1].byteLength = bytes
  const execution = run.annotationExecution as any
  execution.original.byteLength = bytes
  execution.inputs[0].byteLength = bytes
  assert.doesNotThrow(() => encodeProjectBackup(resigned(value), key))
  execution.inputs[1].byteLength = bytes
  value.tables.private_assets[2].byteLength = bytes
  assert.throws(() => encodeProjectBackup(resigned(value), key), { code: "BACKUP_ANNOTATION_INVALID" })
  for (const status of ["generating", "saving", "save_pending", "complete"]) {
    const invalid = fixture()
    invalid.tables.generation_runs[1].status = status
    invalid.tables.generation_runs[1].annotationExecution = null
    assert.throws(() => encodeProjectBackup(resigned(invalid), key), { code: "BACKUP_ANNOTATION_INVALID" })
  }
  // 恢复将中断的preparing变为unknown，因此不能拒绝所有unknown/null组合。
  const restoredPreparing = fixture()
  restoredPreparing.tables.generation_runs[1].status = "unknown"
  restoredPreparing.tables.generation_runs[1].annotationExecution = null
  restoredPreparing.tables.private_assets = restoredPreparing.tables.private_assets.filter(asset => asset.runId !== second)
  assert.doesNotThrow(() => encodeProjectBackup(resigned(restoredPreparing), key))
})


test("完整历史来源随任务冻结；重录和换绑后仍可复核，来源篡改或失去记录者被拒绝", () => {
  const value = fixture(), run = value.tables.generation_runs[1]
  const current = value.tables.provider_settings[0].annotationCapabilities as any[]
  const sourceEvidence = { mappingId: "mapping-a", evidence: structuredClone(current[0].evidence) }
  ;(run.providerAnnotationCapability as any).sourceEvidence = structuredClone(sourceEvidence)
  ;(run.annotationExecution as any).capability.sourceEvidence = structuredClone(sourceEvidence)
  value.tables.provider_settings[0].annotationCapabilities = []
  value.tables.provider_settings[0].baseUrl = "https://another-synthetic.example/v1"
  value.tables.user.find(user => user.id === admin)!.role = "user"
  const restored = decodeProjectBackup(encodeProjectBackup(resigned(value), key), key)
  assert.deepEqual((restored.tables.generation_runs[1].providerAnnotationCapability as any).sourceEvidence, sourceEvidence)
  for (const mutate of [
    (source: any) => { source.evidence.note = "被修改的历史说明" },
    (source: any) => { source.mappingId = "different-mapping" },
    (source: any) => { source.evidence.actorId = "missing-actor" },
  ]) {
    const invalid = structuredClone(value), changed = invalid.tables.generation_runs[1]
    mutate((changed.providerAnnotationCapability as any).sourceEvidence)
    mutate((changed.annotationExecution as any).capability.sourceEvidence)
    assert.throws(() => encodeProjectBackup(resigned(invalid), key))
  }
})
