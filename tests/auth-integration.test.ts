// Dedicated fixture only. This suite deliberately fails without explicit test
// configuration; it never falls back to IMAGE_DATABASE_URL or a cloud database.
import assert from "node:assert/strict"
import { test } from "node:test"
import { hashPassword } from "better-auth/crypto"
import { bootstrapAdministrator, changePassword, createAccount, listAccounts, manageAccount } from "../lib/auth/accounts"
import { AccountError, accountErrorResponse, assertSameOrigin, requireAccount } from "../lib/auth/guards"
import { handleAuthRequest } from "../lib/auth/http"
import { getAuth } from "../lib/auth/server"
import { setTimeout as delay } from "node:timers/promises"
import { closeDatabase, getDatabase } from "../lib/database"
import { GET as sessionResponse } from "../app/api/account/session/route"
import { POST as createResponse } from "../app/api/admin/users/route"
import { POST as modelsResponse } from "../app/api/provider/models/route"
import { POST as passwordResponse } from "../app/api/account/password/route"
import { assertAccountTestFixture } from "../scripts/database/test-fixture"
import dns from "node:dns/promises"
import https from "node:https"
import { syncBuiltinESMExports } from "node:module"
import crypto from "node:crypto"

const testUrl = process.env.IMAGE_AUTH_TEST_DATABASE_URL
if (!testUrl) throw new Error("Set IMAGE_AUTH_TEST_DATABASE_URL to the dedicated local acceptance fixture; this suite never uses default credentials")
const parsed = new URL(testUrl)
if (parsed.hostname !== "127.0.0.1" || parsed.port !== "32768" || parsed.pathname !== "/qintopia_image" || parsed.username !== "qintopia_image_app") throw new Error("Authentication tests require the fixed local acceptance fixture")
process.env.IMAGE_DATABASE_URL = testUrl
process.env.IMAGE_DATABASE_TARGET = "local"
process.env.BETTER_AUTH_SECRET = "synthetic-auth-integration-secret-32-characters"
process.env.BETTER_AUTH_URL = "http://localhost:3000"
Object.assign(process.env, { NODE_ENV: "test" })

const origin = process.env.BETTER_AUTH_URL
const password = "Synthetic-admin-password-01"
function request(path: string, body: unknown, headers?: Headers) {
  const result = new Headers(headers)
  result.set("origin", origin)
  result.set("content-type", "application/json")
  return new Request(`${origin}${path}`, { method: "POST", headers: result, body: JSON.stringify(body) })
}
async function login(username: string, password: string, extraHeaders?: Headers) {
  const response = await handleAuthRequest(request("/api/auth/sign-in/username", { username, password }, extraHeaders))
  const headers = new Headers()
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ")
  if (cookies) headers.set("cookie", cookies)
  return { response, headers }
}
function expectCode(code: string) { return (error: unknown) => error instanceof AccountError && error.code === code }

test("真实 PostgreSQL 账号生命周期、并发与权限", async (t) => {
  const pool = await getDatabase()
  // This is synthetic fixture teardown through the verified runtime identity;
  // no DDL, TRUNCATE, role changes, or production credentials are used.
  async function deleteFixtureRows(sql: string) {
    await assertAccountTestFixture(pool)
    await pool.query(sql)
  }
  async function clearFixture() {
    await deleteFixtureRows("DELETE FROM app.account_audit")
    await deleteFixtureRows('DELETE FROM app."user"')
    await deleteFixtureRows('DELETE FROM app."rateLimit"')
    await deleteFixtureRows("DELETE FROM app.verification")
  }
  await clearFixture()
  t.after(async () => { await clearFixture(); await closeDatabase() })
  let adminHeaders: Headers
  let adminId: string

  await t.test("并发初始化只创建一位管理员，重复执行不覆盖密码", async () => {
    const attempts = await Promise.allSettled([
      bootstrapAdministrator({ username: "Test_Admin", name: "合成管理员", password }),
      bootstrapAdministrator({ username: "other_admin", name: "重复管理员", password: "Never-overwrite-password" }),
    ])
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1)
    const result = attempts.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof bootstrapAdministrator>>>
    // Either contender may win; use its actual credential for later checks.
    const initialPassword = result.value.username === "test_admin" ? password : "Never-overwrite-password"
    const session = await login(result.value.username, initialPassword)
    assert.equal(session.response.status, 200, await session.response.clone().text())
    adminHeaders = session.headers
    adminId = result.value.id
    assert.equal((await requireAccount(adminHeaders, { admin: true })).id, adminId)
    await assert.rejects(bootstrapAdministrator({ username: "replacement", name: "替换", password }), expectCode("ADMIN_EXISTS"))
    const cookie = session.response.headers.get("set-cookie")!
    assert.match(cookie, /httponly/i)
    assert.match(cookie, /samesite=lax/i)
    assert.doesNotMatch(cookie, /session_data/)
    const body = await session.response.json()
    assert.equal("token" in body, false)
    assert.equal("email" in body.user, false)
  })

  await t.test("未知公开认证路径、跨域和无 Origin 写请求无副作用", async () => {
    for (const path of ["/api/auth/sign-up/email", "/api/auth/admin/create-user", "/api/auth/admin/set-role", "/api/auth/admin/impersonate-user", "/api/auth/get-session", "/api/auth/change-password", "/api/auth/admin/remove-user"]) {
      assert.equal((await handleAuthRequest(request(path, {}))).status, 404)
    }
    const cross = request("/api/auth/sign-out", {}, adminHeaders)
    cross.headers.set("origin", "https://evil.example")
    assert.equal((await handleAuthRequest(cross)).status, 403)
    const missing = request("/api/admin/users", { username: "cross_site", name: "跨站" }, adminHeaders)
    missing.headers.delete("origin")
    assert.equal((await createResponse(missing)).status, 403)
    assert.throws(() => assertSameOrigin(missing), expectCode("FORBIDDEN"))
    assert.equal((await pool.query('SELECT id FROM app."user" WHERE username=$1', ["cross_site"])).rowCount, 0)
  })

  await t.test("最后管理员禁用与重置均拒绝", async () => {
    await assert.rejects(manageAccount(adminHeaders, adminId, { action: "disable" }), expectCode("LAST_ADMIN"))
    await assert.rejects(manageAccount(adminHeaders, adminId, { action: "reset-password" }), expectCode("LAST_ADMIN"))
    assert.equal((await requireAccount(adminHeaders, { admin: true })).id, adminId)
  })

  await t.test("重复用户名不覆盖；临时密码并发只兑换一次；仅允许改密和退出", async () => {
    const created = await createAccount(adminHeaders, { username: "New_User", name: "合成普通用户", role: "admin" })
    assert.equal(created.user.role, "user")
    assert.ok(created.expiresAt.getTime() > Date.now() + 23 * 60 * 60 * 1000)
    await assert.rejects(createAccount(adminHeaders, { username: "new_user", name: "重复" }), expectCode("USERNAME_TAKEN"))
    const attempts = await Promise.all([login("new_user", created.temporaryPassword), login("NEW_USER", created.temporaryPassword)])
    assert.deepEqual(attempts.map((attempt) => attempt.response.status).sort(), [200, 401])
    const temporary = attempts.find((attempt) => attempt.response.ok)!
    assert.equal((await requireAccount(temporary.headers, { allowPasswordChange: true })).mustChangePassword, true)
    await assert.rejects(requireAccount(temporary.headers), expectCode("PASSWORD_CHANGE_REQUIRED"))
    await assert.rejects(createAccount(temporary.headers, { username: "forged", name: "越权" }), expectCode("PASSWORD_CHANGE_REQUIRED"))
    const session = await sessionResponse(new Request(`${origin}/api/account/session`, { headers: temporary.headers }))
    const json = await session.json()
    assert.deepEqual(Object.keys(json.user).sort(), ["id", "mustChangePassword", "name", "role", "username"].sort())
    assert.deepEqual(await changePassword(temporary.headers, { currentPassword: created.temporaryPassword, newPassword: "New-permanent-password-01" }), { ok: true })
    await assert.rejects(requireAccount(temporary.headers), expectCode("UNAUTHENTICATED"))
    assert.equal((await login("new_user", created.temporaryPassword)).response.status, 401)
    const permanent = await login("new_user", "New-permanent-password-01")
    assert.equal(permanent.response.status, 200)
    assert.equal((await requireAccount(permanent.headers)).mustChangePassword, false)
    await assert.rejects(createAccount(permanent.headers, { username: "forged", name: "越权" }), expectCode("FORBIDDEN"))
    await assert.rejects(listAccounts(permanent.headers, new URL(`${origin}/api/admin/users`)), expectCode("FORBIDDEN"))
  })
  await deleteFixtureRows('DELETE FROM app."rateLimit"')

  await t.test("NFKC等价新密码不能继续保留一次性临时密码", async () => {
    const created = await createAccount(adminHeaders, { username: "norm_user", name: "合成规范化用户" })
    const temporary = await login("norm_user", created.temporaryPassword)
    assert.equal(temporary.response.status, 200)
    const equivalent = [...created.temporaryPassword].map((value) => String.fromCharCode(value.charCodeAt(0) + 0xfee0)).join("")
    assert.notEqual(equivalent, created.temporaryPassword)
    assert.equal(equivalent.normalize("NFKC"), created.temporaryPassword)
    const before = (await pool.query('SELECT password FROM app.account WHERE "userId"=$1', [created.user.id])).rows
    const response = await passwordResponse(request("/api/account/password", { currentPassword: created.temporaryPassword, newPassword: equivalent }, temporary.headers))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, "INVALID_INPUT")
    assert.deepEqual((await pool.query('SELECT password FROM app.account WHERE "userId"=$1', [created.user.id])).rows, before)
    assert.equal((await requireAccount(temporary.headers, { allowPasswordChange: true })).mustChangePassword, true)
    await changePassword(temporary.headers, { currentPassword: created.temporaryPassword, newPassword: "Normalized-distinct-password-01" })
    assert.equal((await login("norm_user", equivalent)).response.status, 401)
    assert.equal((await login("norm_user", "Normalized-distinct-password-01")).response.status, 200)
  })

  await t.test("管理action数组和对象全部拒绝且无任何写入", async () => {
    const { rows: [target] } = await pool.query<{ id: string }>('SELECT id FROM app."user" WHERE username=$1', ["norm_user"])
    async function snapshot() {
      return Promise.all([
        pool.query('SELECT * FROM app."user" WHERE id=$1', [target.id]),
        pool.query('SELECT * FROM app.account WHERE "userId"=$1', [target.id]),
        pool.query('SELECT * FROM app.session WHERE "userId"=$1 ORDER BY id', [target.id]),
        pool.query('SELECT * FROM app.account_audit ORDER BY id'),
        pool.query('SELECT * FROM app."rateLimit" ORDER BY key'),
      ]).then((results) => results.map(({ rows }) => rows))
    }
    const before = await snapshot()
    for (const action of [["disable"], ["restore"], ["reset-password"], { toString: () => "disable" }, { action: "restore" }, new String("reset-password"), null, 1]) {
      await assert.rejects(manageAccount(adminHeaders, target.id, { action }), expectCode("INVALID_INPUT"))
    }
    assert.deepEqual(await snapshot(), before)
  })

  await t.test("真实模型列表route仅管理员可解析配置，其他权限不读请求体也不出网", async (context) => {
    const created = await createAccount(adminHeaders, { username: "rate_user", name: "合成权限及额度用户" })
    const temporary = await login("rate_user", created.temporaryPassword)
    assert.equal(temporary.response.status, 200)
    const permanent = await login("norm_user", "Normalized-distinct-password-01")
    assert.equal(permanent.response.status, 200)
    const lookups = context.mock.method(dns, "lookup", () => { throw new Error("No model route may perform DNS in this test") })
    const outgoing = context.mock.method(https, "request", () => { throw new Error("No model route may open a connection in this test") })
    syncBuiltinESMExports()
    try {
      for (const [headers, requestOrigin, status, code] of [
        [new Headers(), origin, 401, "UNAUTHENTICATED"],
        [permanent.headers, origin, 403, "FORBIDDEN"],
        [temporary.headers, origin, 403, "PASSWORD_CHANGE_REQUIRED"],
        [adminHeaders, "https://evil.example", 403, "FORBIDDEN"],
      ] as const) {
        const forbidden = request("/api/provider/models", { baseUrl: "https://relay.example.invalid", apiKey: "synthetic-token" }, headers)
        forbidden.headers.set("origin", requestOrigin)
        const parse = context.mock.method(forbidden, "json", async () => { throw new Error("Unauthorized request body was parsed") })
        const response = await modelsResponse(forbidden)
        assert.equal(response.status, status)
        assert.equal((await response.json()).error.code, code)
        assert.equal(parse.mock.callCount(), 0)
      }
      const admin = request("/api/provider/models", {}, adminHeaders)
      const parse = context.mock.method(admin, "json", async () => ({}))
      const response = await modelsResponse(admin)
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: "请输入有效的 HTTPS 地址。" })
      assert.equal(parse.mock.callCount(), 1)
      assert.equal(lookups.mock.callCount(), 0)
      assert.equal(outgoing.mock.callCount(), 0)
    } finally {
      context.mock.restoreAll()
      syncBuiltinESMExports()
    }
    await changePassword(temporary.headers, { currentPassword: created.temporaryPassword, newPassword: "Rate-user-permanent-password-01" })
  })
  await deleteFixtureRows('DELETE FROM app."rateLimit"')

  await t.test("会话写入失败回滚临时兑换、会话与审计", async () => {
    const created = await createAccount(adminHeaders, { username: "rollback_user", name: "事务回滚" })
    const context = await (await getAuth()).$context
    const create = context.adapter.create
    context.adapter.create = (async (input) => {
      if (input.model === "session") throw new Error("Synthetic session insert failure")
      return create(input)
    }) as typeof create
    try {
      assert.equal((await login("rollback_user", created.temporaryPassword)).response.status, 500)
    } finally { context.adapter.create = create }
    const { rows: [state] } = await pool.query('SELECT "temporaryPasswordUsedAt" FROM app."user" WHERE id=$1', [created.user.id])
    assert.equal(state.temporaryPasswordUsedAt, null)
    assert.equal((await pool.query('SELECT id FROM app.session WHERE "userId"=$1', [created.user.id])).rowCount, 0)
    assert.equal((await pool.query('SELECT id FROM app.account_audit WHERE "subjectId"=$1 AND action=$2', [created.user.id, "sign-in"])).rowCount, 0)
    assert.equal((await pool.query('SELECT count FROM app."rateLimit" WHERE key LIKE $1', ["accounts:sign-in:%"])).rows[0].count, 1)
    assert.equal((await login("rollback_user", created.temporaryPassword)).response.status, 200)
  })
  await deleteFixtureRows('DELETE FROM app."rateLimit"')

  await t.test("临时密码过期和已兑换后退出均需要管理员重置", async () => {
    const expired = await createAccount(adminHeaders, { username: "expired_user", name: "过期" })
    await pool.query('UPDATE app."user" SET "temporaryPasswordExpiresAt"=now()-interval \'1 second\' WHERE id=$1', [expired.user.id])
    const absent = await login("no_such_user", "Incorrect-password-01")
    const failed = await login("expired_user", expired.temporaryPassword)
    assert.equal(failed.response.status, 401)
    assert.deepEqual(await absent.response.json(), await failed.response.json())
    const reset = await manageAccount(adminHeaders, expired.user.id, { action: "reset-password" })
    const temporary = await login("expired_user", reset.temporaryPassword!)
    assert.equal(temporary.response.status, 200)
    assert.equal((await handleAuthRequest(request("/api/auth/sign-out", {}, temporary.headers))).status, 200)
    assert.equal((await login("expired_user", reset.temporaryPassword!)).response.status, 401)
    await assert.rejects(requireAccount(temporary.headers, { allowPasswordChange: true }), expectCode("UNAUTHENTICATED"))
  })
  await deleteFixtureRows('DELETE FROM app."rateLimit"')

  await t.test("禁用、恢复和重置使全部旧会话永久失效", async () => {
    const first = await login("new_user", "New-permanent-password-01")
    const second = await login("new_user", "New-permanent-password-01")
    const user = await requireAccount(first.headers)
    await manageAccount(adminHeaders, user.id, { action: "disable" })
    for (const session of [first, second]) await assert.rejects(requireAccount(session.headers), expectCode("UNAUTHENTICATED"))
    assert.equal((await login("new_user", "New-permanent-password-01")).response.status, 401)
    await manageAccount(adminHeaders, user.id, { action: "restore" })
    for (const session of [first, second]) await assert.rejects(requireAccount(session.headers), expectCode("UNAUTHENTICATED"))
    const restored = await login("new_user", "New-permanent-password-01")
    assert.equal(restored.response.status, 200)
    const reset = await manageAccount(adminHeaders, user.id, { action: "reset-password" })
    await assert.rejects(requireAccount(restored.headers), expectCode("UNAUTHENTICATED"))
    assert.equal((await login("new_user", "New-permanent-password-01")).response.status, 401)
    const temporary = await login("new_user", reset.temporaryPassword!)
    assert.equal(temporary.response.status, 200)
    await changePassword(temporary.headers, { currentPassword: reset.temporaryPassword, newPassword: "Race-permanent-password-02" })
  })
  await deleteFixtureRows('DELETE FROM app."rateLimit"')

  await t.test("登录与重置并发：旧凭据不能留下可用会话", async () => {
    const { rows: [target] } = await pool.query<{ id: string }>('SELECT id FROM app."user" WHERE username=$1', ["new_user"])
    const context = await (await getAuth()).$context
    const verify = context.password.verify
    let entered!: () => void
    let release!: () => void
    const verified = new Promise<void>((resolve) => { entered = resolve })
    const continueSession = new Promise<void>((resolve) => { release = resolve })
    context.password.verify = async (input) => {
      const result = await verify(input)
      entered()
      await continueSession
      return result
    }
    const loginAttempt = login("new_user", "Race-permanent-password-02")
    await verified
    const resetAttempt = manageAccount(adminHeaders, target.id, { action: "reset-password" })
    try {
      let blocked = false
      for (let iteration = 0; iteration < 100 && !blocked; iteration += 1) {
        const { rows: [locks] } = await pool.query("SELECT count(*) AS total FROM pg_locks WHERE NOT granted AND pid IN (SELECT pid FROM pg_stat_activity WHERE application_name='qintopia-image-runtime')")
        blocked = Number(locks.total) > 0
        if (!blocked) await delay(10)
      }
      assert.equal(blocked, true, "reset must wait for the login transaction after password verification")
    } finally { release(); context.password.verify = verify }
    const [attempt, reset] = await Promise.all([loginAttempt, resetAttempt])
    assert.ok([200, 401].includes(attempt.response.status))
    if (attempt.response.ok) await assert.rejects(requireAccount(attempt.headers, { allowPasswordChange: true }), expectCode("UNAUTHENTICATED"))
    assert.equal((await pool.query('SELECT id FROM app.session WHERE "userId"=$1', [target.id])).rowCount, 0)
    const temporary = await login("new_user", reset.temporaryPassword!)
    assert.equal(temporary.response.status, 200)
    const changes = await Promise.allSettled([
      changePassword(temporary.headers, { currentPassword: reset.temporaryPassword, newPassword: "Concurrent-password-first" }),
      changePassword(temporary.headers, { currentPassword: reset.temporaryPassword, newPassword: "Concurrent-password-second" }),
    ])
    assert.equal(changes.filter((change) => change.status === "fulfilled").length, 1)
    assert.equal((await pool.query('SELECT id FROM app.session WHERE "userId"=$1', [target.id])).rowCount, 0)
  })

  await t.test("管理员互相禁用并发保留至少一个可用管理员", async () => {
    const second = await createAccount(adminHeaders, { username: "second_admin", name: "第二位合成管理员" })
    // Test fixture promotion is never exposed by an application route.
    await pool.query('UPDATE app."user" SET role=$1,"mustChangePassword"=false,"temporaryPasswordExpiresAt"=NULL WHERE id=$2', ["admin", second.user.id])
    await pool.query('UPDATE app.account SET password=$1 WHERE "userId"=$2', [await hashPassword("Second-admin-password-01"), second.user.id])
    const secondSession = await login("second_admin", "Second-admin-password-01")
    assert.equal(secondSession.response.status, 200)
    const mutations = await Promise.allSettled([
      manageAccount(adminHeaders, second.user.id, { action: "disable" }),
      manageAccount(secondSession.headers, adminId, { action: "disable" }),
    ])
    assert.equal(mutations.filter((mutation) => mutation.status === "fulfilled").length, 1)
    const { rows: [count] } = await pool.query('SELECT count(*) AS total FROM app."user" WHERE role=$1 AND banned=false AND "mustChangePassword"=false', ["admin"])
    assert.equal(Number(count.total), 1)
    const survivors = await Promise.allSettled([requireAccount(adminHeaders, { admin: true }), requireAccount(secondSession.headers, { admin: true })])
    assert.equal(survivors.filter((survivor) => survivor.status === "fulfilled").length, 1)
    if (survivors[1].status === "fulfilled") adminHeaders = secondSession.headers
  })

  await t.test("分页有上限、响应和审计不包含凭证", async () => {
    const page = await listAccounts(adminHeaders, new URL(`${origin}/api/admin/users?limit=2`))
    assert.equal(page.users.length, 2)
    assert.ok(page.total >= 4)
    assert.equal(page.limit, 2)
    await assert.rejects(listAccounts(adminHeaders, new URL(`${origin}/api/admin/users?limit=101`)), expectCode("INVALID_INPUT"))
    const serialized = JSON.stringify(page)
    assert.equal(serialized.includes("temporaryPassword"), false)
    const { rows: audit } = await pool.query("SELECT * FROM app.account_audit")
    assert.ok(audit.length > 10)
    assert.equal(JSON.stringify(audit).includes(password), false)
    assert.equal(JSON.stringify(audit).includes("token"), false)
    const unauthenticated = await sessionResponse(new Request(`${origin}/api/account/session`))
    assert.deepEqual(await unauthenticated.json(), { user: null })
  })

  await t.test("规范化用户名独立持久限流，伪造IP和并发不能绕过且窗口会恢复", async () => {
    await deleteFixtureRows('DELETE FROM app."rateLimit"')
    const attempts = await Promise.all(Array.from({ length: 16 }, (_, index) => login(
      ["absent", " ABSENT ", "Absent"][index % 3], "Invalid-password-for-test",
      new Headers({ "x-forwarded-for": `192.0.2.${index + 1}`, "x-real-ip": `192.0.2.${index + 1}` }),
    )))
    assert.equal(attempts.filter(({ response }) => response.status === 401).length, 10)
    assert.equal(attempts.filter(({ response }) => response.status === 429).length, 6)
    const rateLimited = await login("absent", "Invalid-password-for-test")
    assert.equal(rateLimited.response.status, 429)
    assert.ok(Number(rateLimited.response.headers.get("x-retry-after")) > 0)
    const { rows: rates } = await pool.query('SELECT key,count FROM app."rateLimit"')
    assert.equal(rates.length, 1)
    const [rate] = rates
    assert.equal(rate.count, 10)
    assert.equal((await login("norm_user", "Normalized-distinct-password-01")).response.status, 200)
    await pool.query('UPDATE app."rateLimit" SET "lastRequest"="lastRequest"-60001 WHERE key=$1', [rate.key])
    assert.equal((await login("ABSENT", "Invalid-password-for-test")).response.status, 401)
    assert.equal((await pool.query('SELECT count FROM app."rateLimit" WHERE key=$1', [rate.key])).rows[0].count, 1)
  })

  await t.test("改密错误旧密码消耗原子额度，耗尽后不运行任何scrypt", async (context) => {
    await deleteFixtureRows('DELETE FROM app."rateLimit"')
    const session = await login("rate_user", "Rate-user-permanent-password-01")
    assert.equal(session.response.status, 200)
    const user = await requireAccount(session.headers)
    const before = (await pool.query('SELECT password FROM app.account WHERE "userId"=$1', [user.id])).rows
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => changePassword(session.headers, {
      currentPassword: "Wrong-current-password-01", newPassword: "Changed-permanent-password-01",
    })))
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected" && expectCode("INVALID_PASSWORD")(attempt.reason)).length, 5)
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected" && expectCode("RATE_LIMITED")(attempt.reason)).length, 3)
    assert.deepEqual((await pool.query('SELECT password FROM app.account WHERE "userId"=$1', [user.id])).rows, before)
    const hashing = context.mock.method(crypto, "scrypt", () => { throw new Error("Exhausted callers must not run scrypt") })
    syncBuiltinESMExports()
    try {
      await assert.rejects(hashPassword("Synthetic-spy-control-password"), /Exhausted callers must not run scrypt/)
      assert.equal(hashing.mock.callCount(), 1)
      const response = await passwordResponse(request("/api/account/password", { currentPassword: "Rate-user-permanent-password-01", newPassword: "Changed-permanent-password-01" }, session.headers))
      assert.equal(response.status, 429)
      assert.equal(hashing.mock.callCount(), 1)
    } finally {
      context.mock.restoreAll()
      syncBuiltinESMExports()
    }
    assert.equal((await requireAccount(session.headers)).id, user.id)
    const { rows: [rate] } = await pool.query('SELECT key,count FROM app."rateLimit" WHERE key LIKE $1', ["accounts:change-password:%"])
    assert.equal(rate.count, 5)
    await pool.query('UPDATE app."rateLimit" SET "lastRequest"="lastRequest"-60001 WHERE key=$1', [rate.key])
    assert.deepEqual(await changePassword(session.headers, { currentPassword: "Rate-user-permanent-password-01", newPassword: "Changed-permanent-password-01" }), { ok: true })
  })

  await t.test("管理员开户和重置共享账号额度，失败也计数且耗尽前拦截hash", async (context) => {
    await deleteFixtureRows('DELETE FROM app."rateLimit"')
    const created = await createAccount(adminHeaders, { username: "admin_rate_user", name: "合成管理员额度用户" })
    await pool.query('UPDATE app."user" SET role=$1,"mustChangePassword"=false,"temporaryPasswordExpiresAt"=NULL WHERE id=$2', ["admin", created.user.id])
    await pool.query('UPDATE app.account SET password=$1 WHERE "userId"=$2', [await hashPassword("Rate-admin-permanent-password-01"), created.user.id])
    const session = await login("admin_rate_user", "Rate-admin-permanent-password-01")
    assert.equal(session.response.status, 200)
    for (let index = 0; index < 10; index += 1) {
      if (index % 2 === 0) {
        await assert.rejects(createAccount(session.headers, { username: "norm_user", name: "合成重复用户" }), expectCode("USERNAME_TAKEN"))
      } else {
        await assert.rejects(manageAccount(session.headers, "synthetic-missing-target", { action: "reset-password" }), expectCode("ACCOUNT_NOT_FOUND"))
      }
    }
    const hashing = context.mock.method(crypto, "scrypt", () => { throw new Error("Exhausted admins must not hash") })
    syncBuiltinESMExports()
    try {
      await assert.rejects(hashPassword("Synthetic-spy-control-password"), /Exhausted admins must not hash/)
      assert.equal(hashing.mock.callCount(), 1)
      await assert.rejects(createAccount(session.headers, { username: "norm_user", name: "合成重复用户" }), expectCode("RATE_LIMITED"))
      await assert.rejects(manageAccount(session.headers, created.user.id, { action: "reset-password" }), expectCode("RATE_LIMITED"))
      assert.equal(hashing.mock.callCount(), 1)
    } finally {
      context.mock.restoreAll()
      syncBuiltinESMExports()
    }
    // Another administrator retains an independent allowance.
    await assert.rejects(createAccount(adminHeaders, { username: "norm_user", name: "合成重复用户" }), expectCode("USERNAME_TAKEN"))
  })

  await t.test("未知错误脱敏", async () => {
    const result = accountErrorResponse(new Error("synthetic SQL password should be hidden"))
    assert.equal(result.status, 500)
    assert.equal((await result.text()).includes("synthetic"), false)
  })
})
