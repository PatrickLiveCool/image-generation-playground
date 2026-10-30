import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import sharp from "sharp"
import { bootstrapAdministrator, changePassword, createAccount } from "../lib/auth/accounts"
import { handleAuthRequest } from "../lib/auth/http"
import { AccountError } from "../lib/auth/errors"
import { accountIdentity } from "../lib/auth/guards"
import { closeDatabase, getDatabase } from "../lib/database"
import { serializeAnnotationSnapshot, type AnnotationSnapshot } from "../lib/image-annotations"
import { validateAnnotationExecution } from "../lib/annotation-execution"
import { serializeResolvedAnnotationCapabilityEvidence, validateResolvedAnnotationCapability } from "../lib/annotation-capability"
import { assertPrivateKey, type PrivateCosStore } from "../lib/private-cos"
import { executePrivateGeneration, repairPrivateGeneration, type PrivateGenerationDependencies } from "../lib/private-generation"
import { bytesHash, parsePrivateGenerationForm } from "../lib/private-generation-input"
import * as workspace from "../lib/private-workspace-service"
import { disableAdminAnnotationCapability, recordAdminAnnotationCapability, saveAdminProvider } from "../lib/provider-configuration"
import { assertAccountTestFixture } from "../scripts/database/test-fixture"

// Only the main agent runs this file serially against the approved synthetic database.
const testUrl = process.env.IMAGE_ANNOTATION_TEST_DATABASE_URL
if (!testUrl) throw new Error("Set IMAGE_ANNOTATION_TEST_DATABASE_URL to the dedicated local synthetic fixture")
const target = new URL(testUrl)
if (target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1" || target.port !== "32768" || target.pathname !== "/qintopia_image" || target.username !== "qintopia_image_app" || target.search || target.hash) throw new Error("Annotation tests require the fixed local acceptance fixture")
Object.assign(process.env, {
  IMAGE_DATABASE_URL: testUrl, IMAGE_DATABASE_TARGET: "local", NODE_ENV: "test", BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "synthetic-annotation-auth-secret-32-characters", PROVIDER_CONFIG_KEY: Buffer.alloc(32, 61).toString("base64"),
  IMAGE_GENERATION_MAX_CONCURRENT: "8", IMAGE_GENERATION_PER_USER_CONCURRENT: "8", IMAGE_GENERATION_RATE_PER_MINUTE: "60",
})
const password = "Synthetic-annotation-password-01"
const code = (expected: string) => (error: unknown) => error instanceof AccountError && error.code === expected
async function login(username: string, secret: string): Promise<Headers> {
  const response = await handleAuthRequest(new Request("http://localhost:3000/api/auth/sign-in/username", {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ username, password: secret }),
  }))
  assert.equal(response.status, 200)
  return new Headers({ cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") })
}

test("专用PG批注：能力固定、双输入冻结、幂等、隔离和篡改修复", { concurrency: false }, async t => {
  const pool = await getDatabase()
  async function cleanup() {
    await assertAccountTestFixture(pool)
    const names = ["provider-admin-a", "provider-user"]
    const ids = 'SELECT id FROM app."user" WHERE username=ANY($1::text[])'
    await pool.query('DELETE FROM app.provider_config_audit WHERE "actorId" IN (' + ids + ')', [names])
    await pool.query('DELETE FROM app.provider_settings WHERE "updatedBy" IN (' + ids + ')', [names])
    await pool.query('DELETE FROM app.account_audit WHERE "actorId" IN (' + ids + ') OR "subjectId" IN (' + ids + ')', [names])
    await pool.query('DELETE FROM app."user" WHERE username=ANY($1::text[])', [names])
  }
  t.after(async () => { try { await cleanup() } finally { await closeDatabase() } })
  await cleanup()
  await bootstrapAdministrator({ username: "provider-admin-a", name: "合成批注管理员", password })
  const adminHeaders = await login("provider-admin-a", password)
  const created = await createAccount(adminHeaders, { username: "provider-user", name: "合成批注用户" })
  await changePassword(await login("provider-user", created.temporaryPassword), { currentPassword: created.temporaryPassword, newPassword: password })
  const userHeaders = await login("provider-user", password), user = await accountIdentity(userHeaders), admin = await accountIdentity(adminHeaders)
  let revision = 1
  const config = (current: number, token: string) => ({ revision: current, settings: { baseUrl: "https://synthetic-annotation.example/v1", apiKey: token, apiMode: "images" }, models: [], mappings: [{ id: "mapping-a", name: "合成批注模型", modelId: "synthetic-image-model" }], modelsSynced: false })
  await saveAdminProvider(adminHeaders, config(0, "synthetic-token-1"))
  const creationId = randomUUID()
  const original = await sharp({ create: { width: 80, height: 60, channels: 4, background: "#123456" } }).png().toBuffer()
  const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>()
  const store: PrivateCosStore = {
    async put(key, bytes, mediaType) { assertPrivateKey(key); objects.set(key, { bytes: Buffer.from(bytes), mediaType }) },
    async get(key, maximum) { assertPrivateKey(key); const object = objects.get(key); if (!object || object.bytes.length > maximum) throw new Error("synthetic missing object"); return { ...object, bytes: Buffer.from(object.bytes) } },
  }
  let calls = 0, failCompletion = false
  const dependencies: Partial<PrivateGenerationDependencies> = {
    store,
    service: { ...workspace, async completePrivateRun(...args) { if (failCompletion) { failCompletion = false; throw new Error("synthetic metadata outage") }; return workspace.completePrivateRun(...args) } },
    generate: async (_settings, request) => {
      calls++
      if (request.images.length) {
        assert.equal(request.images.length, 2)
        assert.deepEqual(Buffer.from(request.images[0].bytes), original)
        assert.notDeepEqual(Buffer.from(request.images[1].bytes), original)
        const { rows } = await pool.query('SELECT "annotationExecution",status FROM app.generation_runs WHERE "ownerId"=$1 AND status=\'generating\'', [user.user.id])
        assert.equal(rows.length, 1)
        const execution = validateAnnotationExecution(rows[0].annotationExecution)
        assert.equal(execution.inputs[0].sha256, bytesHash(original))
        for (const input of execution.inputs) assert.equal(bytesHash(objects.get(input.key)!.bytes), input.sha256)
      }
      return { bytes: original, mediaType: "image/png" }
    },
  }
  function form(snapshot?: AnnotationSnapshot) {
    const data = new FormData()
    for (const [key, value] of Object.entries({ creationId, clientRequestId: randomUUID(), mappingId: "mapping-a", configRevision: String(revision), prompt: snapshot ? "" : "合成基准", aspectRatio: "square", quality: "auto", mode: snapshot ? "image-editing" : "text-to-image" })) data.set(key, value)
    if (snapshot) { data.set("parentVersionId", snapshot.baseVersionId); data.set("annotationSnapshot", JSON.stringify(snapshot)) }
    return data
  }
  const base = await executePrivateGeneration(user, await parsePrivateGenerationForm(form()), undefined, dependencies)
  assert.equal(base.status, "complete")
  const snapshot: AnnotationSnapshot = { schema: 1, coordinateSpace: "encoded-pixels-v1", baseVersionId: base.id,
    image: { assetId: base.imageUrl!.split("/").pop()!, width: 80, height: 60, orientation: 1, pages: 1 },
    marks: [{ id: randomUUID(), number: 7, instruction: "改为绿色", geometry: { type: "rectangle", x: 2, y: 2, width: 20, height: 10 } }],
  }
  await t.test("未知能力拒绝且不调用模型；当前账号不能引用他人基准", async () => {
    await assert.rejects(executePrivateGeneration(user, await parsePrivateGenerationForm(form(snapshot)), undefined, dependencies), code("ANNOTATION_CAPABILITY_UNAVAILABLE"))
    assert.equal(calls, 1)
    await assert.rejects(workspace.readPrivateAsset(admin, snapshot.image.assetId, "image"), code("NOT_FOUND"))
  })
  await recordAdminAnnotationCapability(adminHeaders, { revision, mappingId: "mapping-a", evidenceReference: "https://synthetic.example/evidence", evidenceNote: "仅模拟传递验收，不证明实际模型效果", confirmed: true }); revision++
  await t.test("归档后冻结、保存失败、Token换绑后重复受理和补保存沿用原能力", async () => {
    const input = await parsePrivateGenerationForm(form(snapshot))
    failCompletion = true
    const pending = await executePrivateGeneration(user, input, undefined, dependencies)
    assert.equal(pending.status, "save_pending")
    const record = await workspace.readPrivateRun(user, pending.id)
    assert.deepEqual(record.public.annotationSnapshot, snapshot)
    assert.equal(record.annotationExecution!.capability.configurationRevision, revision)
    const frozenCapability = structuredClone(record.provider.annotationCapability!)
    assert.equal(frozenCapability.sourceEvidence!.mappingId, "mapping-a")
    assert.equal(frozenCapability.sourceEvidence!.evidence.note, "仅模拟传递验收，不证明实际模型效果")
    assert.equal(bytesHash(serializeResolvedAnnotationCapabilityEvidence(frozenCapability)!), frozenCapability.evidenceSha256)
    assert.equal(record.annotationExecution!.snapshotSha256, bytesHash(serializeAnnotationSnapshot(snapshot)))
    const count = calls
    await recordAdminAnnotationCapability(adminHeaders, { revision, mappingId: "mapping-a", evidenceReference: "https://synthetic.example/re-recorded", evidenceNote: "同连接重录资料", confirmed: true }); revision++
    assert.deepEqual((await workspace.readPrivateRun(user, pending.id)).provider.annotationCapability, frozenCapability)
    await saveAdminProvider(adminHeaders, config(revision, "synthetic-token-2")); revision++
    assert.deepEqual((await workspace.readPrivateRun(user, pending.id)).provider.annotationCapability, frozenCapability)
    assert.equal((await executePrivateGeneration(user, input, undefined, dependencies)).status, "save_pending")
    const repaired = await repairPrivateGeneration(user, pending.id, dependencies)
    assert.equal(repaired.status, "complete")
    assert.deepEqual((await workspace.readPrivateCreation(userHeaders, creationId)).versions.find(run => run.id === repaired.id)!.annotationSnapshot, snapshot)
    assert.equal(calls, count)
    await assert.rejects(workspace.freezePrivateAnnotationExecution(user.user.id, pending.id, record.annotationExecution!), code("ANNOTATION_EXECUTION_CONFLICT"))
    await assert.rejects(executePrivateGeneration(user, await parsePrivateGenerationForm(form(snapshot)), undefined, dependencies), code("ANNOTATION_CAPABILITY_UNAVAILABLE"))
  })
  await recordAdminAnnotationCapability(adminHeaders, { revision, mappingId: "mapping-a", evidenceReference: "https://synthetic.example/evidence-2", evidenceNote: "换绑后的合成证据", confirmed: true }); revision++
  await t.test("同请求并发只受理一次，已冻结值拒绝重复和不同绑定", async () => {
    const input = await parsePrivateGenerationForm(form(snapshot))
    const accepts = await Promise.all(Array.from({ length: 12 }, () => workspace.acceptPrivateRun(user, input.command)))
    assert.equal(accepts.filter(value => value.acquired).length, 1)
    const record = accepts[0].record, prefix = record.outputKey.slice(0, -"/outputs/final".length)
    const execution = validateAnnotationExecution({ schema: 1, expression: "overlay-v1", renderVersion: 1,
      snapshotSha256: bytesHash(serializeAnnotationSnapshot(snapshot)),
      original: { assetId: snapshot.image.assetId, sha256: bytesHash(original), byteLength: original.length, width: 80, height: 60, orientation: 1, pages: 1 },
      inputs: [{ role: "original", id: randomUUID(), key: `${prefix}/inputs/reference-1`, sha256: bytesHash(original), byteLength: original.length }, { role: "overlay", id: randomUUID(), key: `${prefix}/inputs/reference-2`, sha256: "a".repeat(64), byteLength: 200 }],
      capability: record.provider.annotationCapability,
    })
    await assert.rejects(workspace.setPrivateRunStatus(user.user.id, record.public.id, "generating"), code("INVALID_INPUT"))
    await workspace.freezePrivateAnnotationExecution(user.user.id, record.public.id, execution)
    await assert.rejects(workspace.freezePrivateAnnotationExecution(user.user.id, record.public.id, execution), code("ANNOTATION_EXECUTION_CONFLICT"))
    const changed = structuredClone(execution); changed.inputs[1].sha256 = "b".repeat(64)
    await assert.rejects(workspace.freezePrivateAnnotationExecution(user.user.id, record.public.id, changed), code("ANNOTATION_EXECUTION_CONFLICT"))
    await workspace.setPrivateRunStatus(user.user.id, record.public.id, "failed", "REQUEST_ABORTED")
  })
  await t.test("清单请求或冻结角色篡改不能补记，恢复原清单后只保存一次", async () => {
    failCompletion = true
    const pending = await executePrivateGeneration(user, await parsePrivateGenerationForm(form(snapshot)), undefined, dependencies)
    assert.equal(pending.status, "save_pending")
    const record = await workspace.readPrivateRun(user, pending.id), originalManifest = objects.get(record.manifestKey)!
    const count = calls
    for (const mutate of [(manifest: any) => { manifest.input.prompt = "伪造要求" }, (manifest: any) => { manifest.annotationExecution.inputs.reverse() }]) {
      const manifest = JSON.parse(Buffer.from(originalManifest.bytes).toString()); mutate(manifest)
      objects.set(record.manifestKey, { bytes: Buffer.from(JSON.stringify(manifest)), mediaType: "application/json" })
      await assert.rejects(repairPrivateGeneration(user, pending.id, dependencies), code("RUN_REPAIR_UNAVAILABLE"))
      assert.equal((await workspace.readPrivateRun(user, pending.id)).public.status, "save_pending")
    }
    objects.set(record.manifestKey, originalManifest)
    assert.equal((await repairPrivateGeneration(user, pending.id, dependencies)).status, "complete")
    assert.equal(calls, count)
  })

  await t.test("停用后拒绝新批注、普通生成可用，既有任务携完整证据完成补保存", async () => {
    failCompletion = true
    const input = await parsePrivateGenerationForm(form(snapshot))
    const pending = await executePrivateGeneration(user, input, undefined, dependencies)
    assert.equal(pending.status, "save_pending")
    const before = await workspace.readPrivateRun(user, pending.id), frozen = structuredClone(before.provider.annotationCapability!)
    const modelCalls = calls
    await disableAdminAnnotationCapability(adminHeaders, { revision, mappingId: "mapping-a" }); revision++
    await assert.rejects(executePrivateGeneration(user, await parsePrivateGenerationForm(form(snapshot)), undefined, dependencies), code("ANNOTATION_CAPABILITY_UNAVAILABLE"))
    assert.equal(calls, modelCalls)
    assert.equal((await executePrivateGeneration(user, input, undefined, dependencies)).status, "save_pending")
    const after = await workspace.readPrivateRun(user, pending.id)
    assert.deepEqual(after.provider.annotationCapability, frozen)
    assert.deepEqual(validateResolvedAnnotationCapability(frozen, { sha256: bytesHash, mappingId: "mapping-a", configurationRevision: before.provider.revision }), frozen)
    const repaired = await repairPrivateGeneration(user, pending.id, dependencies)
    assert.equal(repaired.status, "complete")
    assert.doesNotMatch(JSON.stringify(repaired), /sourceEvidence|actorId|evidenceSha256|synthetic\.example\/evidence/)
    assert.equal(calls, modelCalls)
    const ordinary = await executePrivateGeneration(user, await parsePrivateGenerationForm(form()), undefined, dependencies)
    assert.equal(ordinary.status, "complete")
    assert.equal(calls, modelCalls + 1)
  })
})
