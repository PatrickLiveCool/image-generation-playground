import assert from "node:assert/strict"
import { test } from "node:test"
import dns from "node:dns/promises"
import https from "node:https"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { bootstrapAdministrator, changePassword, createAccount } from "../lib/auth/accounts"
import { handleAuthRequest } from "../lib/auth/http"
import { AccountError } from "../lib/auth/errors"
import { closeDatabase, getDatabase } from "../lib/database"
import { readAdminProvider, saveAdminProvider, syncAdminProvider, readPublicModelCatalog, resolveGenerationProvider, recordAdminAnnotationCapability, disableAdminAnnotationCapability, MAX_PROVIDER_JSON_BYTES } from "../lib/provider-configuration"
import { decryptProviderSecret } from "../lib/provider-secret"
import { GET as adminGet, PUT as adminPut } from "../app/api/admin/provider/route"
import { POST as syncPost } from "../app/api/provider/models/route"
import { GET as catalogGet } from "../app/api/models/route"
import { POST as annotationPost, DELETE as annotationDelete } from "../app/api/admin/provider/annotation-capabilities/route"
import { assertAccountTestFixture } from "../scripts/database/test-fixture"

const testUrl = process.env.IMAGE_PROVIDER_TEST_DATABASE_URL
if (!testUrl) throw new Error("Set IMAGE_PROVIDER_TEST_DATABASE_URL to the dedicated local acceptance fixture; no default database is allowed")
const target = new URL(testUrl)
if (target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1" || target.port !== "32768" || target.pathname !== "/qintopia_image" || target.username !== "qintopia_image_app" || target.search || target.hash) throw new Error("Provider tests require the fixed local acceptance fixture")
Object.assign(process.env, {
  IMAGE_DATABASE_URL: testUrl, IMAGE_DATABASE_TARGET: "local", NODE_ENV: "test",
  BETTER_AUTH_SECRET: "synthetic-provider-auth-secret-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000", PROVIDER_CONFIG_KEY: Buffer.alloc(32, 61).toString("base64"),
})
const origin = "http://localhost:3000"
const password = "Synthetic-provider-password-01"
const token = "synthetic-upstream-token-never-real"
const settings = { baseUrl: "https://synthetic-provider.example/custom/v1", apiKey: token, apiMode: "images" as const }
const actualModelId = "openai/gpt-image-1.5"
const configuration = (revision = 0, apiKey = token) => ({ revision, settings: { ...settings, apiKey }, models: [{ id: actualModelId }], mappings: [{ id: "mapping-a", name: "均衡", modelId: actualModelId }], modelsSynced: true })
const expectCode = (code: string) => (error: unknown) => error instanceof AccountError && error.code === code
function request(path: string, body: unknown, headers = new Headers(), method = "POST") {
  const allHeaders = new Headers(headers)
  allHeaders.set("origin", origin)
  allHeaders.set("content-type", "application/json")
  return new Request(origin + path, { method, headers: allHeaders, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) })
}
async function login(username: string, secret: string) {
  const response = await handleAuthRequest(request("/api/auth/sign-in/username", { username, password: secret }))
  assert.equal(response.status, 200, await response.clone().text())
  return new Headers({ cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") })
}

test("专用 PostgreSQL 模型配置：密文、权限、版本并发与草稿同步", async t => {
  const pool = await getDatabase()
  async function deleteRows(sql: string) { await assertAccountTestFixture(pool); await pool.query(sql) }
  async function cleanup() {
    await assertAccountTestFixture(pool)
    const names = ["provider-admin-a", "provider-admin-b", "provider-user", "provider-temp", "provider-evidence-admin"]
    const ids = 'SELECT id FROM app."user" WHERE username=ANY($1::text[])'
    await pool.query('DELETE FROM app.provider_config_audit WHERE "actorId" IN (' + ids + ')', [names])
    await pool.query('DELETE FROM app.provider_settings WHERE "updatedBy" IN (' + ids + ')', [names])
    await pool.query('DELETE FROM app.account_audit WHERE "actorId" IN (' + ids + ') OR "subjectId" IN (' + ids + ')', [names])
    await pool.query('DELETE FROM app."user" WHERE username=ANY($1::text[])', [names])
  }
  t.after(async () => { try { await cleanup() } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await closeDatabase() } })
  await cleanup()
  await bootstrapAdministrator({ username: "provider-admin-a", name: "合成配置管理员甲", password })
  const admin = await login("provider-admin-a", password)
  async function permanent(username: string, role: "admin" | "user") {
    const created = await createAccount(admin, { username, name: "合成配置测试" })
    const temporary = await login(username, created.temporaryPassword)
    await changePassword(temporary, { currentPassword: created.temporaryPassword, newPassword: password })
    await pool.query('UPDATE app."user" SET role=$1 WHERE id=$2', [role, created.user.id])
    return { id: created.user.id, headers: await login(username, password) }
  }
  const adminB = await permanent("provider-admin-b", "admin")
  const user = await permanent("provider-user", "user")
  const temporary = await createAccount(admin, { username: "provider-temp", name: "合成临时用户" })
  const tempHeaders = await login("provider-temp", temporary.temporaryPassword)

  // 在 publicFetch 的系统网络边界模拟响应；保留真实 DNS/IP 固定、超时与重定向逻辑。
  let upstreamBody = JSON.stringify({ data: [{ id: "draft-model-b" }, { id: "draft-model-a" }, { id: "draft-model-a" }] })
  let upstreamStatus = 200
  let dnsAddresses = [{ address: "8.8.8.8", family: 4 }]
  const outbound: https.RequestOptions[] = []
  const dnsMock = t.mock.method(dns, "lookup", async () => dnsAddresses)
  t.mock.method(https, "request", ((options: https.RequestOptions, callback: (response: unknown) => void) => {
    outbound.push(options)
    return { on() { return this }, end() {
      const response = Object.assign(new PassThrough(), { statusCode: upstreamStatus, headers: { "content-type": "application/json" } })
      callback(response)
      response.end(upstreamBody)
    } }
  }) as unknown as typeof https.request)
  syncBuiltinESMExports()
  const snapshot = async () => (await pool.query("SELECT * FROM app.provider_settings")).rows

  await t.test("空配置与缺密钥、普通/临时/匿名和跨站访问均按边界拒绝", async () => {
    assert.equal((await readAdminProvider(admin)).revision, 0)
    assert.equal((await readPublicModelCatalog(user.headers)).configured, false)
    const key = process.env.PROVIDER_CONFIG_KEY
    delete process.env.PROVIDER_CONFIG_KEY
    try { await assert.rejects(readAdminProvider(admin), expectCode("PROVIDER_SECRET_UNAVAILABLE")) }
    finally { process.env.PROVIDER_CONFIG_KEY = key }
    for (const [headers, status] of [[new Headers(), 401], [user.headers, 403], [tempHeaders, 403]] as const) {
      assert.equal((await adminGet(request("/api/admin/provider", null, headers, "GET"))).status, status)
      assert.equal((await adminPut(request("/api/admin/provider", configuration(), headers, "PUT"))).status, status)
      assert.equal((await syncPost(request("/api/provider/models", { revision: 0, ...settings }, headers))).status, status)
      assert.equal((await annotationPost(request("/api/admin/provider/annotation-capabilities", {}, headers))).status, status)
      assert.equal((await annotationDelete(request("/api/admin/provider/annotation-capabilities", {}, headers, "DELETE"))).status, status)
    }
    assert.equal((await catalogGet(request("/api/models", null, tempHeaders, "GET"))).status, 403)
    for (const endpoint of ["/api/admin/provider", "/api/provider/models"]) {
      const cross = request(endpoint, configuration(), admin, endpoint.includes("admin") ? "PUT" : "POST")
      cross.headers.set("origin", "https://untrusted.example")
      assert.equal((await (endpoint.includes("admin") ? adminPut(cross) : syncPost(cross))).status, 403)
    }
    const crossAnnotation = request("/api/admin/provider/annotation-capabilities", {}, admin)
    crossAnnotation.headers.set("origin", "https://untrusted.example")
    assert.equal((await annotationPost(crossAnnotation)).status, 403)
    assert.equal((await annotationDelete(new Request(crossAnnotation.url, { method: "DELETE", headers: crossAnnotation.headers, body: "{}" }))).status, 403)
    await assert.rejects(saveAdminProvider(admin, configuration(0, "")), expectCode("INVALID_INPUT"))
    assert.equal(outbound.length, 0)
    assert.equal(dnsMock.mock.callCount(), 0)
    assert.deepEqual(await snapshot(), [])
  })

  await t.test("两管理员同时初始化只有一次成功，数据库与响应无明文秘密", async () => {
    const results = await Promise.allSettled([saveAdminProvider(admin, configuration()), saveAdminProvider(adminB.headers, configuration())])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(results.filter(result => result.status === "rejected" && expectCode("PROVIDER_REVISION_CONFLICT")(result.reason)).length, 1)
    const view = await readAdminProvider(admin)
    assert.equal(view.revision, 1)
    assert.equal(view.secretConfigured, true)
    assert.equal(view.settings.apiKey, "")
    assert.equal(JSON.stringify(view).includes(token), false)
    const stored = await snapshot()
    assert.equal(JSON.stringify(stored).includes(token), false)
    assert.equal(decryptProviderSecret(stored[0].tokenCiphertext), token)
    assert.equal((await pool.query("SELECT revision,action FROM app.provider_config_audit")).rows.length, 1)
    assert.equal(dnsMock.mock.callCount(), 0)
    assert.equal(outbound.length, 0)
  })

  await t.test("安全目录仅含名称和比例，生成解析仅服务端含真实模型及密钥", async () => {
    const catalog = await readPublicModelCatalog(user.headers)
    assert.equal(catalog.configured, true)
    assert.deepEqual(Object.keys(catalog.mappings[0]).sort(), ["annotation", "aspectRatios", "id", "name"])
    assert.deepEqual(catalog.mappings[0].aspectRatios, ["square", "3:2", "2:3"])
    assert.doesNotMatch(JSON.stringify(catalog), /synthetic-upstream|synthetic-provider|gpt-image|apiKey|baseUrl|modelId/)
    const resolved = await resolveGenerationProvider(user.headers, "mapping-a")
    assert.equal(resolved.settings.apiKey, token)
    assert.equal(resolved.mapping.modelId, actualModelId)
    await assert.rejects(resolveGenerationProvider(user.headers, "removed-id"), expectCode("MODEL_MAPPING_NOT_FOUND"))
  })

  await t.test("空 Token 保留旧秘密，修改地址须新 Token，失败及 stale revision 不落库", async () => {
    const saved = await saveAdminProvider(admin, configuration(1, ""))
    assert.equal(saved.revision, 2)
    assert.equal(decryptProviderSecret((await snapshot())[0].tokenCiphertext), token)
    const before = await snapshot()
    await assert.rejects(saveAdminProvider(admin, { ...configuration(2, ""), settings: { ...settings, apiKey: "", baseUrl: "https://new-provider.example/v1" } }), expectCode("INVALID_INPUT"))
    await assert.rejects(saveAdminProvider(admin, configuration(1)), expectCode("PROVIDER_REVISION_CONFLICT"))
    await assert.rejects(saveAdminProvider(admin, { ...configuration(2), mappings: [{ id: "same", name: "重复", modelId: "m" }, { id: "other", name: "重复", modelId: "m" }] }), expectCode("INVALID_INPUT"))
    assert.deepEqual(await snapshot(), before)
    assert.equal(outbound.length, 0)
    assert.equal(dnsMock.mock.callCount(), 0)
  })

  await t.test("草稿同步取同地址旧密钥或新地址新密钥，候选排序去重且从不保存", async () => {
    const before = await snapshot()
    const draft = { revision: 2, ...settings, apiKey: "" }
    assert.deepEqual(await syncAdminProvider(admin, draft), { models: [{ id: "draft-model-a" }, { id: "draft-model-b" }] })
    assert.equal(outbound.length, 1)
    assert.equal(outbound[0].hostname, "8.8.8.8")
    assert.equal(outbound[0].servername, "synthetic-provider.example")
    assert.equal(outbound[0].path, "/custom/v1/models")
    assert.equal((outbound[0].headers as Record<string, string>).authorization, `Bearer ${token}`)
    await assert.rejects(syncAdminProvider(admin, { ...draft, baseUrl: "https://new-provider.example/v2" }), expectCode("INVALID_INPUT"))
    for (const baseUrl of [settings.baseUrl + "/", " " + settings.baseUrl, settings.baseUrl.replace("synthetic-provider", "SYNTHETIC-PROVIDER")]) {
      await assert.rejects(syncAdminProvider(admin, { ...draft, baseUrl }), expectCode("INVALID_INPUT"))
      await assert.rejects(saveAdminProvider(admin, { ...configuration(2, ""), settings: { ...settings, apiKey: "", baseUrl } }), expectCode("INVALID_INPUT"))
    }
    await assert.rejects(syncAdminProvider(admin, { ...draft, revision: 1 }), expectCode("PROVIDER_REVISION_CONFLICT"))
    assert.equal(outbound.length, 1)
    await syncAdminProvider(admin, { ...draft, baseUrl: "https://new-provider.example/v2", apiKey: "synthetic-new-token" })
    assert.equal((outbound[1].headers as Record<string, string>).authorization, "Bearer synthetic-new-token")
    assert.equal(outbound[1].servername, "new-provider.example")
    assert.deepEqual(await snapshot(), before)
  })

  await t.test("模型同步保留公网 DNS、重定向、响应大小及候选数量上限", async () => {
    const draft = { revision: 2, ...settings, apiKey: "" }
    const before = await snapshot()
    const calls = outbound.length
    dnsAddresses = [{ address: "127.0.0.1", family: 4 }]
    await assert.rejects(syncAdminProvider(admin, draft), expectCode("PROVIDER_SYNC_FAILED"))
    assert.equal(outbound.length, calls)
    dnsAddresses = [{ address: "8.8.8.8", family: 4 }]
    upstreamStatus = 302
    await assert.rejects(syncAdminProvider(admin, draft), expectCode("PROVIDER_SYNC_FAILED"))
    upstreamStatus = 200
    for (const value of ["invalid-json", JSON.stringify({ data: Array.from({ length: 5001 }, (_, index) => ({ id: `m-${index}` })) }), JSON.stringify({ data: [{ id: "secret\ninvalid" }] }), "x".repeat(MAX_PROVIDER_JSON_BYTES + 1)]) {
      upstreamBody = value
      await assert.rejects(syncAdminProvider(admin, draft), expectCode("PROVIDER_SYNC_FAILED"))
    }
    upstreamBody = JSON.stringify({ data: [] })
    assert.deepEqual(await syncAdminProvider(admin, draft), { models: [] })
    assert.deepEqual(await snapshot(), before)
  })

  await t.test("缺失、错误密钥和损坏密文不能读取或覆盖配置，可恢复原密钥与密文", async () => {
    const before = await snapshot()
    const key = process.env.PROVIDER_CONFIG_KEY!
    for (const invalid of [undefined, "bad-key", Buffer.alloc(32, 62).toString("base64")]) {
      if (invalid === undefined) delete process.env.PROVIDER_CONFIG_KEY
      else process.env.PROVIDER_CONFIG_KEY = invalid
      await assert.rejects(readAdminProvider(admin), expectCode("PROVIDER_SECRET_UNAVAILABLE"))
      await assert.rejects(saveAdminProvider(admin, configuration(2)), expectCode("PROVIDER_SECRET_UNAVAILABLE"))
    }
    process.env.PROVIDER_CONFIG_KEY = key
    assert.deepEqual(await snapshot(), before)
    await pool.query('UPDATE app.provider_settings SET "tokenCiphertext"=$1 WHERE singleton=1', ["broken-envelope"])
    try {
      await assert.rejects(readAdminProvider(admin), expectCode("PROVIDER_SECRET_UNAVAILABLE"))
      await assert.rejects(saveAdminProvider(admin, configuration(2)), expectCode("PROVIDER_SECRET_UNAVAILABLE"))
    } finally { await pool.query('UPDATE app.provider_settings SET "tokenCiphertext"=$1 WHERE singleton=1', [before[0].tokenCiphertext]) }
    assert.equal((await readAdminProvider(admin)).revision, 2)
  })

  await t.test("写事务会复核已被降权的管理员和已撤销会话", async () => {
    const before = await snapshot()
    for (const change of ["role", "session"] as const) {
      const blocker = await pool.connect()
      try {
        await blocker.query("BEGIN")
        await blocker.query('SELECT id FROM app."user" WHERE id=$1 FOR UPDATE', [adminB.id])
        const pending = saveAdminProvider(adminB.headers, configuration(2, ""))
        const assertion = assert.rejects(pending, expectCode(change === "role" ? "FORBIDDEN" : "UNAUTHENTICATED"))
        let waiting = false
        for (let index = 0; index < 100; index++) {
          const state = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1", ['SELECT id,username,name,role,banned,%FROM app."user" WHERE id=$1 FOR UPDATE'])
          if (state.rowCount) { waiting = true; break }
          await delay(10)
        }
        assert.equal(waiting, true, "配置保存必须进入事务内账号复核等待")
        if (change === "role") await blocker.query('UPDATE app."user" SET role=$1 WHERE id=$2', ["user", adminB.id])
        else { await assertAccountTestFixture(pool); await blocker.query('DELETE FROM app.session WHERE "userId"=$1', [adminB.id]) }
        await blocker.query("COMMIT")
        await assertion
      } finally { await blocker.query("ROLLBACK"); blocker.release() }
      await pool.query('UPDATE app."user" SET role=$1 WHERE id=$2', ["admin", adminB.id])
    }
    assert.deepEqual(await snapshot(), before)
  })

  await t.test("空映射目录合法，删除后提交明确失败；相同 revision 并发只有一笔更新", async () => {
    adminB.headers = await login("provider-admin-b", password)
    const attempts = await Promise.allSettled([saveAdminProvider(admin, { ...configuration(2, ""), mappings: [] }), saveAdminProvider(adminB.headers, { ...configuration(2, ""), mappings: [] })])
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(attempts.filter(result => result.status === "rejected" && expectCode("PROVIDER_REVISION_CONFLICT")(result.reason)).length, 1)
    assert.deepEqual((await readPublicModelCatalog(user.headers)).mappings, [])
    assert.equal((await readPublicModelCatalog(user.headers)).configured, false)
    await assert.rejects(resolveGenerationProvider(user.headers, "mapping-a"), expectCode("MODEL_MAPPING_NOT_FOUND"))
    assert.deepEqual((await pool.query("SELECT revision FROM app.provider_config_audit ORDER BY revision")).rows, [{ revision: 1 }, { revision: 2 }, { revision: 3 }])
  })

  await t.test("独立能力记录绑定已保存配置，并发revision、资料确认和公开投影均核验", async () => {
    const calls = outbound.length, lookups = dnsMock.mock.callCount()
    let view = await saveAdminProvider(admin, { ...configuration(3, ""), mappings: [configuration().mappings[0], { id: "mapping-b", name: "辅助", modelId: "synthetic-other-model" }] })
    const evidence = (mappingId = "mapping-a") => ({ revision: view.revision, mappingId, evidenceReference: "https://docs.example/two-image-inputs", evidenceNote: "合成资料仅确认输入契约，不证明真实编辑效果。", confirmed: true })
    const before = await snapshot()
    for (const invalid of [{ ...evidence(), confirmed: false }, { ...evidence(), evidenceReference: "http://docs.example" }, { ...evidence(), evidenceNote: "" }, { ...evidence(), settings }, { ...evidence(), revision: view.revision - 1 }]) {
      const response = await annotationPost(request("/api/admin/provider/annotation-capabilities", invalid, admin))
      assert.ok(response.status === 400 || response.status === 409)
    }
    assert.deepEqual(await snapshot(), before)
    const results = await Promise.allSettled([recordAdminAnnotationCapability(admin, evidence()), recordAdminAnnotationCapability(adminB.headers, evidence())])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(results.filter(result => result.status === "rejected" && expectCode("PROVIDER_REVISION_CONFLICT")(result.reason)).length, 1)
    view = await readAdminProvider(admin)
    const first = view.annotationCapabilities[0]
    assert.equal(first.mappingId, "mapping-a")
    assert.equal(first.configurationRevision, view.revision)
    assert.ok(first.evidence.actorId)
    const response = await annotationPost(request("/api/admin/provider/annotation-capabilities", evidence("mapping-b"), admin))
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(response.headers.get("cache-control"), "no-store")
    view = await response.json()
    assert.equal(view.annotationCapabilities.length, 2)
    assert.deepEqual(view.annotationCapabilities.find(item => item.mappingId === "mapping-a")!.evidence, first.evidence)
    assert.ok(view.annotationCapabilities.every(item => item.configurationRevision === view.revision))
    const catalog = await readPublicModelCatalog(user.headers)
    assert.deepEqual(catalog.mappings[0].annotation, { available: true, expression: "overlay-v1", maxInputImages: 2, reason: null })
    assert.doesNotMatch(JSON.stringify(catalog), /docs\.example|合成资料|bindingSha256|evidenceSha256|actorId|recordedAt|gpt-image|synthetic-upstream|synthetic-provider/)
    const resolved = await resolveGenerationProvider(user.headers, "mapping-a")
    assert.deepEqual(Object.keys(resolved.annotationCapability!).sort(), ["bindingSha256", "configurationRevision", "evidenceSha256", "expression", "maxInputImages", "sourceEvidence"])
    assert.deepEqual(resolved.annotationCapability!.sourceEvidence, { mappingId: "mapping-a", evidence: first.evidence })
    const priorEvidence = view.annotationCapabilities.map(item => item.evidence)
    view = await saveAdminProvider(admin, { ...configuration(view.revision, ""), mappings: [...view.mappings].reverse().map(item => ({ ...item, name: item.name + "新名称" })) })
    assert.deepEqual(view.annotationCapabilities.map(item => item.evidence), priorEvidence)
    assert.ok(view.annotationCapabilities.every(item => item.configurationRevision === view.revision))
    assert.equal(view.annotationCapabilities[0].evidenceSha256, first.evidenceSha256)
    // Entering the same Token does not change its identity, even though AES-GCM uses a fresh nonce.
    view = await saveAdminProvider(admin, { ...configuration(view.revision), mappings: view.mappings })
    assert.equal(view.annotationCapabilities.length, 2)
    // Changing only one actual model preserves the other mapping's evidence.
    view = await saveAdminProvider(admin, { ...configuration(view.revision, ""), mappings: view.mappings.map(item => item.id === "mapping-b" ? { ...item, modelId: "synthetic-rebound-model" } : item) })
    assert.deepEqual(view.annotationCapabilities.map(item => item.mappingId), ["mapping-a"])
    view = await saveAdminProvider(admin, { ...configuration(view.revision, "synthetic-replaced-token"), mappings: view.mappings })
    assert.deepEqual(view.annotationCapabilities, [])
    assert.equal((await readPublicModelCatalog(user.headers)).mappings[0].annotation.available, false)
    for (const change of ["apiMode", "baseUrl", "delete"] as const) {
      view = await recordAdminAnnotationCapability(admin, evidence())
      const nextSettings = { ...view.settings, apiKey: "" }
      if (change === "apiMode") nextSettings.apiMode = "chat"
      if (change === "baseUrl") { nextSettings.baseUrl = "https://other-synthetic.example/v1"; nextSettings.apiKey = "synthetic-new-address-token" }
      view = await saveAdminProvider(admin, { revision: view.revision, settings: nextSettings, models: view.models, modelsSynced: view.modelsSynced, mappings: change === "delete" ? [] : view.mappings })
      assert.deepEqual(view.annotationCapabilities, [], `${change} must invalidate the prior binding`)
    }
    assert.equal(outbound.length, calls, "记录/继承/失效均不调用模型或同步目录")
    assert.equal(dnsMock.mock.callCount(), lookups)
  })

  await t.test("能力记录事务复核等待期间撤销角色或会话不会写入证据", async () => {
    let view = await readAdminProvider(admin)
    view = await saveAdminProvider(admin, { ...configuration(view.revision, "synthetic-last-token") })
    const actor = await permanent("provider-evidence-admin", "admin")
    for (const change of ["role", "session"] as const) {
      const before = await snapshot()
      const blocker = await pool.connect()
      try {
        await blocker.query("BEGIN")
        await blocker.query('SELECT id FROM app."user" WHERE id=$1 FOR UPDATE', [actor.id])
        const pending = recordAdminAnnotationCapability(actor.headers, { revision: view.revision, mappingId: "mapping-a", evidenceReference: "https://docs.example", evidenceNote: "仅用于事务撤权测试。", confirmed: true })
        const assertion = assert.rejects(pending, expectCode(change === "role" ? "FORBIDDEN" : "UNAUTHENTICATED"))
        let waiting = false
        for (let index = 0; index < 100; index++) {
          const state = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1", ['SELECT id,username,name,role,banned,%FROM app."user" WHERE id=$1 FOR UPDATE'])
          if (state.rowCount) { waiting = true; break }
          await delay(10)
        }
        assert.equal(waiting, true)
        if (change === "role") await blocker.query('UPDATE app."user" SET role=$1 WHERE id=$2', ["user", actor.id])
        else { await assertAccountTestFixture(pool); await blocker.query('DELETE FROM app.session WHERE "userId"=$1', [actor.id]) }
        await blocker.query("COMMIT")
        await assertion
      } finally { await blocker.query("ROLLBACK"); blocker.release() }
      assert.deepEqual(await snapshot(), before)
      await pool.query('UPDATE app."user" SET role=$1 WHERE id=$2', ["admin", actor.id])
      actor.headers = await login("provider-evidence-admin", password)
    }
  })

  await t.test("独立停用受revision保护，仅移除选中能力并续用其他证据，普通生成保持可用", async () => {
    let view = await readAdminProvider(admin)
    view = await saveAdminProvider(admin, { ...configuration(view.revision, ""), mappings: [configuration().mappings[0], { id: "mapping-b", name: "第二映射", modelId: "synthetic-second-model" }] })
    for (const mappingId of ["mapping-a", "mapping-b"]) view = await recordAdminAnnotationCapability(admin, { revision: view.revision, mappingId, evidenceReference: "https://synthetic.example/disable-test", evidenceNote: "独立停用边界合成证据", confirmed: true })
    const before = await snapshot(), second = structuredClone(view.annotationCapabilities.find(item => item.mappingId === "mapping-b")!)
    const calls = outbound.length, lookups = dnsMock.mock.callCount()
    await assert.rejects(disableAdminAnnotationCapability(admin, { revision: view.revision - 1, mappingId: "mapping-a" }), expectCode("PROVIDER_REVISION_CONFLICT"))
    await assert.rejects(disableAdminAnnotationCapability(admin, { revision: view.revision, mappingId: "removed" }), expectCode("MODEL_MAPPING_NOT_FOUND"))
    for (const [headers, status] of [[new Headers(), 401], [user.headers, 403], [tempHeaders, 403]] as const) {
      assert.equal((await annotationDelete(request("/api/admin/provider/annotation-capabilities", { revision: view.revision, mappingId: "mapping-a" }, headers, "DELETE"))).status, status)
    }
    assert.deepEqual(await snapshot(), before)
    const results = await Promise.allSettled([disableAdminAnnotationCapability(admin, { revision: view.revision, mappingId: "mapping-a" }), disableAdminAnnotationCapability(adminB.headers, { revision: view.revision, mappingId: "mapping-a" })])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(results.filter(result => result.status === "rejected" && expectCode("PROVIDER_REVISION_CONFLICT")(result.reason)).length, 1)
    view = await readAdminProvider(admin)
    assert.equal(view.revision, before[0].revision + 1)
    assert.deepEqual(view.annotationCapabilities, [{ ...second, configurationRevision: view.revision }])
    const after = (await snapshot())[0]
    for (const field of ["baseUrl", "apiMode", "tokenCiphertext", "models", "mappings", "modelsSynced"]) assert.deepEqual(after[field], before[0][field])
    const ordinary = await resolveGenerationProvider(user.headers, "mapping-a")
    assert.ok(ordinary.settings.apiKey)
    assert.equal(ordinary.mapping.modelId, actualModelId)
    assert.equal(ordinary.annotationCapability, null)
    const catalog = await readPublicModelCatalog(user.headers)
    assert.equal(catalog.configured, true)
    assert.equal(catalog.mappings[0].annotation.available, false)
    assert.equal(catalog.mappings[1].annotation.available, true)
    assert.equal(outbound.length, calls)
    assert.equal(dnsMock.mock.callCount(), lookups)
  })
})
