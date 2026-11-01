import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { bootstrapAdministrator, changePassword, createAccount } from "../lib/auth/accounts"
import { handleAuthRequest } from "../lib/auth/http"
import { AccountError } from "../lib/auth/errors"
import { accountIdentity } from "../lib/auth/guards"
import { closeDatabase, getDatabase } from "../lib/database"
import { assertPrivateKey, privateRunPrefix, type PrivateCosStore } from "../lib/private-cos"
import { executePrivateGeneration, readVerifiedPrivateAsset, repairPrivateGeneration, type PrivateGenerationDependencies } from "../lib/private-generation"
import { bytesHash, parsePrivateGenerationForm } from "../lib/private-generation-input"
import * as privateWorkspace from "../lib/private-workspace-service"
import { acceptPrivateRun, completePrivateRun, createPrivateCreation, listPrivateCreations, readPrivateAsset, readPrivateBase, readPrivateCreation, readPrivateRun, renamePrivateCreation, setPrivateRunStatus } from "../lib/private-workspace-service"
import type { PrivateAssetRecord, PrivateRunRecord, RunCommand } from "../lib/private-workspace-records"
import { saveAdminProvider } from "../lib/provider-configuration"
import { assertAccountTestFixture } from "../scripts/database/test-fixture"

const testUrl = process.env.IMAGE_PRIVATE_WORKSPACE_TEST_DATABASE_URL
if (!testUrl) throw new Error("Set IMAGE_PRIVATE_WORKSPACE_TEST_DATABASE_URL to the dedicated local synthetic fixture; no default database is allowed")
const target = new URL(testUrl)
if (target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1" || target.port !== "32768" || target.pathname !== "/qintopia_image" || target.username !== "qintopia_image_app" || target.search || target.hash) throw new Error("Private workspace tests require the fixed local acceptance fixture")
Object.assign(process.env, {
  IMAGE_DATABASE_URL: testUrl, IMAGE_DATABASE_TARGET: "local", NODE_ENV: "test",
  BETTER_AUTH_SECRET: "synthetic-private-workspace-auth-secret-32-characters", BETTER_AUTH_URL: "http://localhost:3000",
  PROVIDER_CONFIG_KEY: Buffer.alloc(32, 61).toString("base64"), IMAGE_GENERATION_MAX_CONCURRENT: "8", IMAGE_GENERATION_PER_USER_CONCURRENT: "8", IMAGE_GENERATION_RATE_PER_MINUTE: "60",
})
const password = "Synthetic-private-workspace-password-01", token = "synthetic-workspace-token-never-real"
const code = (expected: string) => (error: unknown) => error instanceof AccountError && error.code === expected
async function login(username: string, secret: string): Promise<Headers> {
  const response = await handleAuthRequest(new Request("http://localhost:3000/api/auth/sign-in/username", {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ username, password: secret }),
  }))
  assert.equal(response.status, 200, await response.clone().text())
  return new Headers({ cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") })
}
function command(overrides: Partial<RunCommand> = {}): RunCommand {
  return { creationId: randomUUID(), clientRequestId: randomUUID(), fingerprint: createHash("sha256").update(randomUUID()).digest("hex"), parentVersionId: null, mappingId: "mapping-a", configRevision: 1, prompt: "  合成测试原始提示\n保留空格。 ", aspectRatio: "square", quality: "auto", mode: "text-to-image", ...overrides }
}
function output(record: PrivateRunRecord): PrivateAssetRecord {
  const bytes = Buffer.from("synthetic-output-metadata")
  return { id: record.outputAssetId, ownerId: record.ownerId, creationId: record.public.creationId, runId: record.public.id, key: record.outputKey, kind: "image", mediaType: "image/png", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
}

test("专用 PostgreSQL 私有创作：账号隔离、原子受理、成功版本与故障恢复", { concurrency: false }, async t => {
  const pool = await getDatabase()
  async function deleteRows(sql: string) { await assertAccountTestFixture(pool); await pool.query(sql) }
  async function cleanup() {
    await deleteRows("DELETE FROM app.private_assets")
    await deleteRows("DELETE FROM app.generation_runs")
    await deleteRows("DELETE FROM app.creations")
    await deleteRows("DELETE FROM app.provider_request_slots")
    await deleteRows("DELETE FROM app.provider_config_audit")
    await deleteRows("DELETE FROM app.provider_settings")
    await deleteRows("DELETE FROM app.account_audit")
    await deleteRows('DELETE FROM app."user"')
    await deleteRows('DELETE FROM app."rateLimit"')
    await deleteRows("DELETE FROM app.verification")
  }
  t.after(async () => { try { await cleanup() } finally { await closeDatabase() } })
  await cleanup()
  await bootstrapAdministrator({ username: "provider-admin-a", name: "合成私有空间管理员", password })
  const adminHeaders = await login("provider-admin-a", password), admin = await accountIdentity(adminHeaders)
  const created = await createAccount(adminHeaders, { username: "provider-user", name: "合成私有空间用户" })
  const tempHeaders = await login("provider-user", created.temporaryPassword)
  await changePassword(tempHeaders, { currentPassword: created.temporaryPassword, newPassword: password })
  const userHeaders = await login("provider-user", password), user = await accountIdentity(userHeaders)
  let revision = 1
  const config = (current: number, label = "合成均衡") => ({ revision: current, settings: { baseUrl: "https://synthetic-workspace.example/v1", apiKey: token, apiMode: "images" }, models: [{ id: "synthetic-image-model" }], mappings: [{ id: "mapping-a", name: label, modelId: "synthetic-image-model" }], modelsSynced: true })
  await saveAdminProvider(adminHeaders, config(0))
  const accept = (identity = user, input: Partial<RunCommand> = {}) => acceptPrivateRun(identity, command({ configRevision: revision, ...input }))
  async function finish(record: PrivateRunRecord) { return completePrivateRun(record.ownerId, record.public.id, [output(record)]) }

  await t.test("新账号空列表、相同ID各自创建、创建幂等及并发重命名冲突", async () => {
    assert.deepEqual(await listPrivateCreations(userHeaders), [])
    const id = randomUUID()
    const first = await createPrivateCreation(userHeaders, { id: id.toUpperCase(), title: "私有创作" })
    const again = await createPrivateCreation(userHeaders, { id, title: "不能覆盖" })
    assert.deepEqual(again, first)
    assert.equal(first.id, id)
    await assert.rejects(readPrivateCreation(adminHeaders, id), code("NOT_FOUND"))
    const other = await createPrivateCreation(adminHeaders, { id, title: "管理员自己的同ID创作" })
    assert.equal(other.title, "管理员自己的同ID创作")
    const renamed = await Promise.allSettled([renamePrivateCreation(userHeaders, id, { revision: 1, title: "设备甲" }), renamePrivateCreation(userHeaders, id, { revision: 1, title: "设备乙" })])
    assert.equal(renamed.filter(item => item.status === "fulfilled").length, 1)
    assert.equal(renamed.filter(item => item.status === "rejected" && code("CREATION_REVISION_CONFLICT")(item.reason)).length, 1)
    await assert.rejects(createPrivateCreation(userHeaders, { id: randomUUID(), ownerId: admin.user.id }), code("INVALID_INPUT"))
    await assert.rejects(createPrivateCreation(userHeaders, { id: randomUUID(), title: "长".repeat(61) }), code("INVALID_INPUT"))
    await assert.rejects(listPrivateCreations(new Headers()), code("UNAUTHENTICATED"))
  })

  await t.test("相同请求16次并发只受理一次；只首次返回Token且同id异指纹拒绝", async () => {
    const input = command({ configRevision: revision })
    const accepted = await Promise.all(Array.from({ length: 16 }, () => acceptPrivateRun(user, input)))
    assert.equal(accepted.filter(item => item.acquired).length, 1)
    assert.equal(accepted.filter(item => item.settings?.apiKey === token).length, 1)
    for (const item of accepted) {
      assert.equal(item.record.public.id, input.clientRequestId)
      assert.equal(item.record.public.creationRevision, 2)
    }
    const renamedAfterAcceptance = await renamePrivateCreation(userHeaders, input.creationId, { revision: accepted[0].record.public.creationRevision, title: "受理后立即改名" })
    assert.equal(renamedAfterAcceptance.revision, 3)
    assert.equal(renamedAfterAcceptance.versions[0].creationRevision, 3)
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM app.generation_runs WHERE "ownerId"=$1 AND id=$2', [user.user.id, input.clientRequestId])).rows[0].count, 1)
    await assert.rejects(acceptPrivateRun(user, { ...input, fingerprint: "f".repeat(64) }), code("GENERATION_REQUEST_CONFLICT"))
    const stored = (await pool.query('SELECT * FROM app.generation_runs WHERE "ownerId"=$1 AND id=$2', [user.user.id, input.clientRequestId])).rows[0]
    assert.doesNotMatch(JSON.stringify(stored), /synthetic-workspace-token|tokenCiphertext|apiKey/)
    assert.equal(accepted[0].record.public.prompt, input.prompt)
    await saveAdminProvider(adminHeaders, { ...config(revision, "新显示名"), mappings: [] }); revision += 1
    const key = process.env.PROVIDER_CONFIG_KEY
    delete process.env.PROVIDER_CONFIG_KEY
    try {
      const repeated = await acceptPrivateRun(user, input)
      assert.equal(repeated.acquired, false)
      assert.equal(repeated.settings, undefined)
      assert.equal(repeated.record.public.modelLabel, "合成均衡")
      assert.equal(repeated.record.public.creationRevision, renamedAfterAcceptance.revision)
      assert.equal(repeated.record.provider.revision, 1)
    } finally { process.env.PROVIDER_CONFIG_KEY = key }
    await saveAdminProvider(adminHeaders, config(revision)); revision += 1
    const completed = await finish(accepted[0].record)
    assert.equal(completed.creationRevision, 4)
    const renamedAfterCompletion = await renamePrivateCreation(userHeaders, input.creationId, { revision: completed.creationRevision, title: "完成后立即改名" })
    assert.equal(renamedAfterCompletion.revision, 5)
    assert.equal((await readPrivateRun(user, input.clientRequestId)).public.creationRevision, renamedAfterCompletion.revision)
    assert.equal((await acceptPrivateRun(user, input)).record.public.creationRevision, renamedAfterCompletion.revision)
  })

  await t.test("新请求固定revision；无效配置或父版本不会留下创作、任务和受理槽", async () => {
    for (const input of [command({ configRevision: 1 }), command({ configRevision: revision, parentVersionId: randomUUID(), mode: "image-editing" }), command({ configRevision: revision, mappingId: "removed" })]) {
      await assert.rejects(acceptPrivateRun(user, input), error => error instanceof AccountError && error.status === 409)
      assert.equal((await pool.query('SELECT 1 FROM app.creations WHERE "ownerId"=$1 AND id=$2', [user.user.id, input.creationId])).rowCount, 0)
      assert.equal((await pool.query('SELECT 1 FROM app.provider_request_slots WHERE "userId"=$1 AND "requestId"=$2', [user.user.id, input.clientRequestId])).rowCount, 0)
    }
    await assert.rejects(accept(user, { prompt: "x".repeat(5001) }), code("INVALID_INPUT"))
    await assert.rejects(accept(user, { parentVersionId: randomUUID() }), code("INVALID_INPUT"))
  })

  await t.test("同创作并发任务分配唯一递增版本，列表包含所有状态", async () => {
    const creationId = randomUUID()
    const accepted = (await Promise.all(Array.from({ length: 8 }, () => accept(user, { creationId })))).sort((a, b) => a.record.public.version - b.record.public.version)
    assert.deepEqual(accepted.map(item => item.record.public.version), [1, 2, 3, 4, 5, 6, 7, 8])
    assert.deepEqual(accepted.map(item => item.record.public.creationRevision), [2, 3, 4, 5, 6, 7, 8, 9])
    const statuses = ["preparing", "generating", "saving", "failed", "unknown", "save_pending", "complete", "complete"] as const
    for (const [index, item] of accepted.entries()) {
      if (statuses[index] === "complete") await finish(item.record)
      else await setPrivateRunStatus(user.user.id, item.record.public.id, statuses[index])
    }
    const view = await readPrivateCreation(userHeaders, creationId)
    assert.deepEqual(view.versions.map(item => item.version), [1, 2, 3, 4, 5, 6, 7, 8])
    assert.deepEqual(view.versions.map(item => item.status), statuses)
    assert.equal(view.versions.every(item => item.creationRevision === view.revision), true)
    for (const item of accepted.slice(0, 3)) await setPrivateRunStatus(user.user.id, item.record.public.id, "failed", "INPUT_SAVE_FAILED")
    for (const item of accepted.slice(4, 6)) await finish(item.record)
  })

  let base: PrivateRunRecord
  await t.test("固定outputAssetId及key/hash/大小/归属校验；整批资产事务成功和并发修复幂等", async () => {
    const { record } = await accept(); base = record
    const valid = output(record), prefix = privateRunPrefix(record.ownerId, record.public.creationId, record.public.id)
    const document: PrivateAssetRecord = { ...valid, id: randomUUID(), key: `${prefix}/inputs/document`, kind: "document", mediaType: "text/plain", name: "合成.txt" }
    const reference: PrivateAssetRecord = { ...valid, id: randomUUID(), key: `${prefix}/inputs/reference-1` }
    const invalid = [
      { ...valid, id: randomUUID() }, { ...valid, ownerId: admin.user.id }, { ...valid, runId: randomUUID() }, { ...valid, creationId: randomUUID() },
      { ...valid, key: valid.key.replace("outputs/final", "inputs/reference-2") }, { ...valid, key: "image-playground/legacy/final.png" },
      { ...valid, sha256: "bad" }, { ...valid, byteLength: 0 }, { ...valid, byteLength: 20 * 1024 * 1024 + 1 }, { ...valid, mediaType: "text/html" },
    ]
    for (const candidate of invalid) {
      await assert.rejects(completePrivateRun(user.user.id, record.public.id, [candidate]), error => error instanceof AccountError)
      assert.equal((await pool.query('SELECT 1 FROM app.private_assets WHERE "ownerId"=$1 AND "runId"=$2', [user.user.id, record.public.id])).rowCount, 0)
    }
    await assert.rejects(completePrivateRun(user.user.id, record.public.id, [valid, valid]), code("INVALID_INPUT"))
    const results = await Promise.all([completePrivateRun(user.user.id, record.public.id, [valid, document, reference]), completePrivateRun(user.user.id, record.public.id, [valid, document, reference])])
    assert.deepEqual(results[0], results[1])
    assert.equal(results[0].creationRevision, record.public.creationRevision + 1)
    assert.equal((await readPrivateCreation(userHeaders, record.public.creationId)).revision, results[0].creationRevision)
    assert.equal(results[0].imageUrl, `/api/images/${record.outputAssetId}`)
    assert.deepEqual(results[0].document, { assetId: document.id, name: "合成.txt" })
    assert.equal((await pool.query('SELECT 1 FROM app.private_assets WHERE "ownerId"=$1 AND "runId"=$2', [user.user.id, record.public.id])).rowCount, 3)
    assert.equal((await readPrivateAsset(user, document.id, "document")).name, "合成.txt")
    await assert.rejects(readPrivateAsset(user, document.id, "image"), code("NOT_FOUND"))
    await assert.rejects(readPrivateAsset(user, "malformed-id", "image"), code("NOT_FOUND"))
    await setPrivateRunStatus(user.user.id, record.public.id, "failed", "INPUT_SAVE_FAILED")
    assert.equal((await readPrivateRun(user, record.public.id)).public.status, "complete")
    assert.deepEqual(await completePrivateRun(user.user.id, record.public.id, []), results[0])
    assert.equal((await pool.query('SELECT status FROM app.provider_request_slots WHERE "userId"=$1 AND "requestId"=$2', [user.user.id, record.public.id])).rows[0].status, "finished")
  })

  await t.test("父原图限定账号、创作及成功版本；管理员和其他创作不能读取或续改", async () => {
    assert.equal((await readPrivateBase(user, base.public.creationId, base.public.id))?.id, base.outputAssetId)
    for (const action of [() => readPrivateRun(admin, base.public.id), () => readPrivateAsset(admin, base.outputAssetId, "image")]) await assert.rejects(action, code("NOT_FOUND"))
    await assert.rejects(readPrivateBase(admin, base.public.creationId, base.public.id), code("BASE_VERSION_UNAVAILABLE"))
    await assert.rejects(accept(admin, { creationId: base.public.creationId, parentVersionId: base.public.id, mode: "image-editing" }), code("BASE_VERSION_UNAVAILABLE"))
    await assert.rejects(accept(user, { parentVersionId: base.public.id, mode: "image-editing" }), code("BASE_VERSION_UNAVAILABLE"))
    const edited = await accept(user, { creationId: base.public.creationId.toUpperCase(), parentVersionId: base.public.id.toUpperCase(), mode: "image-editing" })
    assert.equal(edited.record.public.parentVersionId, base.public.id)
    assert.equal(edited.record.public.version, 2)
    await finish(edited.record)
    // 复合owner key允许另一个账号使用相同请求UUID，但绝不复用用户的任务。
    const other = await accept(admin, { clientRequestId: base.public.id, creationId: base.public.creationId })
    assert.equal(other.acquired, true)
    assert.notEqual(other.record.outputKey, base.outputKey)
    await finish(other.record)
  })

  await t.test("超时公开unknown不重发；保存待修复可幂等完成并释放unknown槽", async () => {
    const input = command({ configRevision: revision }), accepted = await acceptPrivateRun(user, input)
    await pool.query('UPDATE app.generation_runs SET "deadlineAt"=statement_timestamp()-interval \'1 second\' WHERE "ownerId"=$1 AND id=$2', [user.user.id, accepted.record.public.id])
    assert.equal((await readPrivateRun(user, accepted.record.public.id)).public.status, "unknown")
    assert.equal((await readPrivateCreation(userHeaders, input.creationId)).versions[0].status, "unknown")
    const repeated = await acceptPrivateRun(user, input)
    assert.equal(repeated.acquired, false)
    assert.equal(repeated.record.public.status, "unknown")
    await setPrivateRunStatus(user.user.id, accepted.record.public.id, "save_pending", "METADATA_SAVE_FAILED")
    assert.equal((await readPrivateRun(user, accepted.record.public.id)).public.status, "save_pending")
    await assert.rejects(setPrivateRunStatus(user.user.id, accepted.record.public.id, "failed", "upstream secret body"), code("INVALID_INPUT"))
    await setPrivateRunStatus(user.user.id, accepted.record.public.id, "failed", "INPUT_SAVE_FAILED")
    assert.equal((await readPrivateRun(user, accepted.record.public.id)).public.status, "save_pending")
    await finish(accepted.record)
    assert.equal((await pool.query('SELECT status FROM app.provider_request_slots WHERE "userId"=$1 AND "requestId"=$2', [user.user.id, accepted.record.public.id])).rows[0].status, "finished")
  })

  await t.test("数据库复合外键拒绝跨账号或跨创作引用", async () => {
    const own = await accept(), other = await accept(admin)
    await assert.rejects(pool.query('UPDATE app.generation_runs SET "parentVersionId"=$3 WHERE "ownerId"=$1 AND id=$2', [user.user.id, own.record.public.id, other.record.public.id]), (error: unknown) => (error as { code: string }).code === "23503")
    await assert.rejects(pool.query('INSERT INTO app.private_assets ("ownerId",id,"creationId","runId",key,kind,"mediaType","byteLength",sha256) VALUES ($1,$2,$3,$4,$5,\'image\',\'image/png\',1,$6)', [admin.user.id, randomUUID(), own.record.public.creationId, own.record.public.id, "synthetic-invalid-owner-test", "a".repeat(64)]), (error: unknown) => (error as { code: string }).code === "23503")
    await finish(own.record); await finish(other.record)
  })

  await t.test("编排安全失败分类原样保留，未知文本仍不能写入失败码", async () => {
    const { record } = await accept()
    for (const failureCode of ["BASE_VERSION_UNAVAILABLE", "REFERENCE_INVALID", "ACCOUNT_UNAVAILABLE", "MODEL_OUTPUT_INVALID", "PROVIDER_AUTH_REJECTED", "PROVIDER_REQUEST_REJECTED", "PROVIDER_RATE_LIMITED", "PROVIDER_UPSTREAM_FAILED", "INPUT_READ_FAILED"]) {
      await setPrivateRunStatus(user.user.id, record.public.id, "failed", failureCode)
      assert.equal((await readPrivateRun(user, record.public.id)).public.failureCode, failureCode)
    }
    await assert.rejects(setPrivateRunStatus(user.user.id, record.public.id, "failed", "UNTRUSTED_UPSTREAM_BODY"), code("INVALID_INPUT"))
    const restored = await readPrivateCreation(userHeaders, record.public.creationId)
    assert.equal(restored.versions[0].failureCode, "INPUT_READ_FAILED")
    assert.equal(restored.versions[0].creationRevision, restored.revision)
  })

  await t.test("真实PG与内存COS编排：原图续改、保存失败补记及重新读取完整版本", async () => {
    const creationId = randomUUID(), firstRunId = randomUUID(), editedRunId = randomUUID()
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64")
    const documentText = "仅调整标题；保持原始构图与颜色。", documentName = "合成修改要求.txt"
    const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>()
    const counts = { model: 0, read: 0, write: 0, complete: 0 }
    const store: PrivateCosStore = {
      async put(key, bytes, mediaType) {
        assertPrivateKey(key)
        counts.write += 1
        objects.set(key, { bytes: Buffer.from(bytes), mediaType })
      },
      async get(key, maximum) {
        assertPrivateKey(key)
        counts.read += 1
        const saved = objects.get(key)
        if (!saved || !saved.bytes.length || saved.bytes.length > maximum) throw new Error("Synthetic in-memory object unavailable")
        return { bytes: Buffer.from(saved.bytes), mediaType: saved.mediaType }
      },
    }
    const dependencies: Partial<PrivateGenerationDependencies> = {
      store,
      async generate(settings, request) {
        counts.model += 1
        assert.equal(settings.apiKey, token)
        assert.equal(request.model, "synthetic-image-model")
        if (counts.model === 1) {
          assert.equal(request.images.length, 0)
          assert.equal(request.prompt, "生成合成图片")
        } else {
          assert.equal(counts.model, 2, "显式补记和重复请求不得再次调用模型")
          assert.equal(request.images.length, 1)
          assert.deepEqual(request.images[0].bytes, png, "续改必须将首次成功的真实原图作为第一输入")
          assert.equal(request.images[0].mediaType, "image/png")
          assert.match(request.prompt, /^以第一张图片为编辑基准/)
          assert.equal(request.prompt.split(`【文档上下文：${documentName}】`).length - 1, 1)
          assert.equal(request.prompt.split(documentText).length - 1, 1)
        }
        // 模拟模型只返回内存中的有效合成PNG，不访问任何上游。
        return { bytes: Buffer.from(png), mediaType: "image/png" }
      },
      async readSource() { throw new Error("External source access is forbidden in the synthetic integration") },
    }
    const form = (runId: string, prompt: string, parent?: string) => {
      const value = new FormData()
      for (const [key, field] of Object.entries({ creationId, clientRequestId: runId, mappingId: "mapping-a", configRevision: String(revision), prompt, aspectRatio: "square", quality: "auto", mode: parent ? "image-editing" : "text-to-image", ...(parent ? { parentVersionId: parent } : {}) })) value.set(key, field)
      return value
    }
    const firstInput = await parsePrivateGenerationForm(form(firstRunId, "生成合成图片"))
    const first = await executePrivateGeneration(user, firstInput, undefined, dependencies)
    assert.equal(first.status, "complete")
    assert.equal(first.version, 1)
    assert.equal(first.creationRevision, 3)
    const firstRecord = await readPrivateRun(user, firstRunId)
    const firstAsset = await readPrivateAsset(user, firstRecord.outputAssetId, "image")
    assert.equal(firstAsset.sha256, bytesHash(png))
    assert.deepEqual((await readVerifiedPrivateAsset(firstAsset, store)).bytes, png)

    const editedForm = form(editedRunId, "  仅修改图片标题  ", firstRunId)
    editedForm.set("document", new File([documentText], documentName, { type: "text/plain" }))
    const editedInput = await parsePrivateGenerationForm(editedForm)
    let failFirstCompletion = true
    const interrupted: Partial<PrivateGenerationDependencies> = {
      ...dependencies,
      service: {
        ...privateWorkspace,
        async completePrivateRun(ownerId, runId, assets) {
          counts.complete += 1
          const record = await readPrivateRun(user, runId)
          assert.ok(objects.has(record.outputKey), "输出已写入固定恢复键后才进行数据库补记")
          assert.equal(JSON.parse(Buffer.from(objects.get(record.manifestKey)!.bytes).toString("utf8")).status, "complete")
          if (failFirstCompletion) { failFirstCompletion = false; throw new Error("Synthetic one-time metadata failure") }
          return completePrivateRun(ownerId, runId, assets)
        },
      },
    }
    const pending = await executePrivateGeneration(user, editedInput, undefined, interrupted)
    assert.equal(pending.status, "save_pending")
    assert.equal(pending.creationRevision, 4)
    assert.equal(pending.failureCode, "METADATA_SAVE_FAILED")
    assert.equal(pending.imageUrl, null)
    assert.equal(counts.model, 2)
    assert.equal((await readPrivateRun(user, editedRunId)).public.status, "save_pending")
    assert.equal((await pool.query('SELECT 1 FROM app.private_assets WHERE "ownerId"=$1 AND "runId"=$2', [user.user.id, editedRunId])).rowCount, 0)

    const repaired = await repairPrivateGeneration(user, editedRunId, interrupted)
    assert.equal(repaired.status, "complete")
    assert.equal(repaired.version, 2)
    assert.equal(repaired.creationRevision, 5)
    assert.equal(repaired.parentVersionId, firstRunId)
    assert.equal(repaired.prompt, "  仅修改图片标题  ")
    assert.equal(repaired.document?.name, documentName)
    assert.equal(counts.complete, 2)
    const afterRepair = { ...counts }
    assert.deepEqual(await repairPrivateGeneration(user, editedRunId, interrupted), repaired)
    assert.deepEqual(await executePrivateGeneration(user, editedInput, undefined, interrupted), repaired)
    assert.deepEqual(counts, afterRepair, "重复补记和提交只返回现有记录，不读写COS、不调用模型")

    const restoredIdentity = await accountIdentity(new Headers(userHeaders))
    const restoredList = await listPrivateCreations(new Headers(userHeaders))
    const restored = await readPrivateCreation(new Headers(userHeaders), creationId)
    assert.deepEqual(restoredList.find(item => item.id === creationId), restored)
    assert.deepEqual(restored.versions, [first, repaired].map(run => ({ ...run, creationRevision: restored.revision })))
    const assets = (await pool.query<PrivateAssetRecord>('SELECT * FROM app.private_assets WHERE "ownerId"=$1 AND "creationId"=$2', [user.user.id, creationId])).rows
    assert.equal(assets.length, 4, "两次输出、续改原图和原始文档均已保存元数据")
    for (const asset of assets) {
      const object = objects.get(asset.key)!
      assert.ok(object)
      assert.equal(asset.byteLength, object.bytes.length)
      assert.equal(asset.sha256, bytesHash(object.bytes))
      const restoredAsset = await readPrivateAsset(restoredIdentity, asset.id, asset.kind)
      assert.deepEqual((await readVerifiedPrivateAsset(restoredAsset, store)).bytes, object.bytes)
    }
    const document = await readPrivateAsset(restoredIdentity, repaired.document!.assetId, "document")
    assert.equal(document.name, documentName)
    assert.equal(document.sha256, bytesHash(Buffer.from(documentText)))
    assert.equal(Buffer.from((await readVerifiedPrivateAsset(document, store)).bytes).toString("utf8"), documentText)
    assert.equal(counts.model, 2)
    assert.equal((await pool.query('SELECT status FROM app.provider_request_slots WHERE "userId"=$1 AND "requestId"=$2', [user.user.id, editedRunId])).rows[0].status, "finished")
  })

  await t.test("受理等待账号锁后复核禁用与过期会话，不留下付费槽", async () => {
    const blocker = await pool.connect(), input = command({ configRevision: revision })
    let attempt: Promise<unknown> | undefined
    try {
      await blocker.query("BEGIN")
      await blocker.query('UPDATE app."user" SET banned=true WHERE id=$1', [user.user.id])
      attempt = assert.rejects(acceptPrivateRun(user, input), code("UNAUTHENTICATED"))
      let waiting = false
      for (let index = 0; index < 100 && !waiting; index += 1) {
        waiting = Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name='qintopia-image-runtime' AND wait_event_type='Lock'")).rowCount)
        if (!waiting) await delay(10)
      }
      assert.equal(waiting, true)
      await blocker.query("COMMIT")
      await attempt
    } finally {
      await blocker.query("ROLLBACK")
      if (attempt) await attempt.catch(() => {})
      blocker.release()
      await pool.query('UPDATE app."user" SET banned=false WHERE id=$1', [user.user.id])
    }
    assert.equal((await pool.query('SELECT 1 FROM app.provider_request_slots WHERE "userId"=$1 AND "requestId"=$2', [user.user.id, input.clientRequestId])).rowCount, 0)
    await pool.query('UPDATE app.session SET "expiresAt"=statement_timestamp()-interval \'1 second\' WHERE id=$1', [user.sessionId])
    await assert.rejects(accept(), code("UNAUTHENTICATED"))
    await assert.rejects(readPrivateRun(user, base.public.id), code("UNAUTHENTICATED"))
  })
})
