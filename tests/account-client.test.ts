import { strict as assert } from "node:assert"
import { test, type TestContext } from "node:test"
import {
  AccountRequestError,
  accountErrorMessage,
  changeAccountPassword,
  createAccount,
  getAccountSession,
  listAccounts,
  signInAccount,
  signOutAccount,
  updateAccount,
} from "../lib/account-client"

const user = { id: "local-user", username: "sample", name: "合成账号", role: "user", mustChangePassword: true }
const temporary = { temporaryPassword: "Synthetic password 123", expiresAt: "2026-10-30T10:00:00.000Z" }
type Reply = { status?: number; value?: unknown; reject?: boolean }

function replies(context: TestContext, queue: Reply[]) {
  const requests: { path: string; init: RequestInit }[] = []
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ path: String(input), init })
    const next = queue.shift()
    assert.ok(next, "不应发生未定义的额外请求")
    if (next.reject) throw new Error("offline")
    return Response.json(next.value ?? {}, { status: next.status ?? 200 })
  })
  context.after(() => assert.equal(queue.length, 0, "已定义响应应全部使用"))
  return requests
}

test("登录后重新查询会话，不信任登录响应中的用户", async (context) => {
  const requests = replies(context, [{ value: { user: { id: "untrusted-login-user" } } }, { value: { user } }])
  assert.equal((await signInAccount(" sample ", "Synthetic password 123")).user?.id, user.id)
  assert.deepEqual(requests.map((request) => request.path), ["/api/auth/sign-in/username", "/api/account/session"])
  assert.equal(JSON.parse(String(requests[0].init.body)).username, "sample")
})

test("登录失败不暴露服务端账号存在性信息", async (context) => {
  replies(context, [{ status: 401, value: { error: { code: "ACCOUNT_NOT_FOUND", message: "leaked user existence" } } }])
  await assert.rejects(signInAccount("missing", "invalid"), (error: unknown) => error instanceof AccountRequestError
    && !error.message.includes("existence") && error.code === "SIGN_IN_FAILED")
})

test("无会话时保持匿名结果，不构造默认用户", async (context) => {
  replies(context, [{ value: { user: null } }])
  assert.equal((await getAccountSession()).user, null)
})

test("拒绝未知角色的会话响应", async (context) => {
  replies(context, [{ value: { user: { ...user, role: "owner" } } }])
  await assert.rejects(getAccountSession(), (error: unknown) => error instanceof AccountRequestError && error.code === "INVALID_RESPONSE")
})

test("退出请求失败时不能报告已撤销会话", async (context) => {
  replies(context, [{ status: 503, value: { error: { code: "INTERNAL_ERROR", message: "服务不可用" } } }])
  await assert.rejects(signOutAccount(), (error: unknown) => accountErrorMessage(error) === "服务不可用")
})

test("改密必须获得明确成功结果", async (context) => {
  replies(context, [{ value: { ok: false } }])
  await assert.rejects(changeAccountPassword("Old synthetic 123", "New synthetic 123"),
    (error: unknown) => error instanceof AccountRequestError && error.code === "INVALID_RESPONSE")
})

test("创建账号提交名称和用户名并返回本次临时密码", async (context) => {
  const requests = replies(context, [{ value: { user, ...temporary } }])
  assert.deepEqual(await createAccount(" sample ", " 合成账号 "), { user, ...temporary })
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { username: "sample", name: "合成账号" })
})

test("重复创建失败不隐式重试或调用重置接口", async (context) => {
  const requests = replies(context, [{ status: 409, value: { error: { code: "USERNAME_TAKEN", message: "用户名已存在" } } }])
  await assert.rejects(createAccount("sample", "合成账号"))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, "/api/admin/users")
  assert.equal(requests[0].init.method, "POST")
})

test("账号列表使用明确分页并保留服务端总数", async (context) => {
  const requests = replies(context, [{ value: {
    users: [{ ...user, banned: false, createdAt: "2026-10-29T10:00:00.000Z" }], total: 26, offset: 25, limit: 25,
  } }])
  const page = await listAccounts(25)
  assert.equal(page.offset, 25)
  assert.equal(page.total, 26)
  assert.equal(requests[0].path, "/api/admin/users?limit=25&offset=25")
})

test("重置只返回本次密码并编码目标账号路径", async (context) => {
  const requests = replies(context, [{ value: { ok: true, ...temporary } }])
  assert.deepEqual(await updateAccount("user/id", "reset-password"), temporary)
  assert.equal(requests[0].path, "/api/admin/users/user%2Fid")
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { action: "reset-password" })
})

test("禁用账号不会返回或构造临时密码", async (context) => {
  replies(context, [{ value: { ok: true } }])
  assert.equal(await updateAccount("local-user", "disable"), null)
})

test("创建时网络中断保留结果不明状态且不自动重试", async (context) => {
  const requests = replies(context, [{ reject: true }])
  await assert.rejects(createAccount("sample", "合成账号"), (error: unknown) => error instanceof AccountRequestError
    && error.code === "NETWORK_ERROR" && error.message.includes("尚未确认"))
  assert.equal(requests.length, 1)
})

test("账号读取和写入全部禁止浏览器缓存并仅携带同源凭据", async (context) => {
  const requests = replies(context, [
    { value: { user } },
    { value: { success: true } },
    { value: { ok: true } },
    { value: { ok: true } },
  ])
  await getAccountSession()
  await signOutAccount()
  await changeAccountPassword("Old synthetic 123", "New synthetic 123")
  await updateAccount(user.id, "restore")
  for (const { init } of requests) {
    assert.equal(init.cache, "no-store")
    assert.equal(init.credentials, "same-origin")
    assert.equal(new Headers(init.headers).get("Cache-Control"), "no-store")
  }
})

test("登录POST成功但会话读取失败时提示仅复核，不再次消费密码", async (context) => {
  const requests = replies(context, [{ value: { success: true } }, { reject: true }, { value: { user } }])
  await assert.rejects(signInAccount("sample", temporary.temporaryPassword), (error: unknown) => error instanceof AccountRequestError
    && error.code === "SIGN_IN_UNCONFIRMED" && error.message.includes("登录请求已提交"))
  assert.equal((await getAccountSession()).user?.id, user.id)
  assert.equal(requests.filter(({ init }) => init.method === "POST").length, 1)
})

test("写请求总超时有界且不会自动重发", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let requests = 0
  let signal: AbortSignal | null | undefined
  context.mock.method(globalThis, "fetch", (_: unknown, init: RequestInit) => {
    requests += 1
    signal = init.signal
    return new Promise<Response>(() => {})
  })
  const result = assert.rejects(createAccount("sample", "合成账号"), (error: unknown) => error instanceof AccountRequestError
    && error.code === "REQUEST_TIMEOUT" && error.message.includes("尚未确认"))
  context.mock.timers.tick(15_000)
  await result
  assert.equal(signal?.aborted, true)
  assert.equal(requests, 1)
})

test("收到响应头后卡住的响应体仍受总超时保护", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start() {} }), {
    headers: { "content-type": "application/json" },
  }))
  const result = assert.rejects(getAccountSession(), (error: unknown) => error instanceof AccountRequestError && error.code === "REQUEST_TIMEOUT")
  await Promise.resolve()
  context.mock.timers.tick(15_000)
  await result
})

test("外部取消即使底层fetch未响应也停止等待", async (context) => {
  context.mock.method(globalThis, "fetch", () => new Promise<Response>(() => {}))
  const controller = new AbortController()
  const result = assert.rejects(getAccountSession(controller.signal), (error: unknown) => error instanceof Error && error.name === "AbortError")
  controller.abort()
  await result
})
