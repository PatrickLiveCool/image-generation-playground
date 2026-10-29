import assert from "node:assert/strict"
import { test } from "node:test"
import { authConfiguration } from "../lib/auth/config"
import { AccountError, accountErrorResponse } from "../lib/auth/errors"
import { normalizeUsername, readJson, validateName, validatePassword } from "../lib/auth/validation"

test("认证配置只接受固定 origin，生产仅 HTTPS，不使用请求 Host", () => {
  const env = { BETTER_AUTH_SECRET: "x".repeat(32), BETTER_AUTH_URL: "https://image.example.invalid", NODE_ENV: "production" } as NodeJS.ProcessEnv
  assert.equal(authConfiguration(env).origin, env.BETTER_AUTH_URL)
  for (const origin of ["http://image.example.invalid", "https://image.example.invalid/", "https://image.example.invalid/path", "https://user:pass@image.example.invalid", "https://image.example.invalid?query=1", "https://image.example.invalid/#fragment", "null"]) {
    assert.throws(() => authConfiguration({ ...env, BETTER_AUTH_URL: origin }))
  }
  assert.throws(() => authConfiguration({ ...env, BETTER_AUTH_SECRET: "short" }))
})

test("账号输入规范化及密码边界", () => {
  assert.equal(normalizeUsername("  User-01_A  "), "user-01_a")
  for (const username of ["ab", "a".repeat(33), "中文名", "a.b", "user@example.com", null]) assert.throws(() => normalizeUsername(username))
  assert.equal(validateName("  测试用户  "), "测试用户")
  assert.throws(() => validateName(" "))
  assert.throws(() => validateName("x".repeat(81)))
  assert.equal(validatePassword("x".repeat(12)).length, 12)
  assert.equal(validatePassword("x".repeat(128)).length, 128)
  for (const password of ["x".repeat(11), "x".repeat(129), null]) assert.throws(() => validatePassword(password))
})

test("内部错误不会把 SQL、密码或连接串返回客户端", async () => {
  const response = accountErrorResponse(new Error("postgresql://secret:password@example/database SQL SELECT"))
  assert.equal(response.status, 500)
  const body = await response.text()
  assert.equal(body.includes("password"), false)
  assert.equal(body.includes("SELECT"), false)
  assert.equal(response.headers.get("cache-control"), "no-store")
})

function jsonStream(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request("http://localhost/auth-test", { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal, duplex: "half" } as RequestInit & { duplex: "half" })
}
const invalidJson = (error: unknown) => error instanceof AccountError && error.code === "INVALID_INPUT"

test("JSON按UTF-8字节限制到16384，边界值可用且拒绝伪造长度", async () => {
  const body = JSON.stringify({ data: "a".repeat(16_373) })
  assert.equal(new TextEncoder().encode(body).byteLength, 16_384)
  const request = (text: string, headers: Record<string, string> = {}) => new Request("http://localhost/auth-test", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text })
  assert.deepEqual(await readJson(request(body)), { data: "a".repeat(16_373) })
  await assert.rejects(readJson(request(JSON.stringify({ data: "中".repeat(6_000) }))), invalidJson)
  await assert.rejects(readJson(request(`${body} `, { "content-length": "1" })), invalidJson)
  for (const text of ["null", "[]", "{}invalid", ""]) await assert.rejects(readJson(request(text)), invalidJson)
  await assert.rejects(readJson(request("{}", { "content-type": "application/json-invalid" })), invalidJson)
})

test("无Content-Length的持续JSON流超限立即取消，不等无限取消回调", async () => {
  let reads = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads += 1; controller.enqueue(new Uint8Array(4_096)) },
    cancel() { cancelled = true; return new Promise(() => undefined) },
  })
  await assert.rejects(readJson(jsonStream(stream)), invalidJson)
  assert.equal(cancelled, true)
  assert.ok(reads <= 6, `expected bounded reads, got ${reads}`)
})

test("声明超限的JSON体不读取内容并取消", async () => {
  let reads = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull() { reads += 1 },
    cancel() { cancelled = true; return new Promise(() => undefined) },
  }, { highWaterMark: 0 })
  await assert.rejects(readJson(jsonStream(stream, { "content-length": "16385" })), invalidJson)
  assert.equal(reads, 0)
  assert.equal(cancelled, true)
})

test("持续空片段不能绕过读取次数边界或占住事件循环", async () => {
  let reads = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads += 1; controller.enqueue(new Uint8Array()) },
    cancel() { cancelled = true },
  })
  await assert.rejects(readJson(jsonStream(stream)), invalidJson)
  assert.equal(cancelled, true)
  assert.ok(reads <= 16_386)
})

test("不关闭的慢JSON流以请求总时限终止，不因收到片段重置且不等cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    cancel() { cancelled = true; return new Promise(() => undefined) },
  })
  const parsing = readJson(jsonStream(stream))
  const rejected = assert.rejects(parsing, (error: unknown) => error instanceof AccountError && error.status === 408)
  controller.enqueue(new TextEncoder().encode('{"data":"'))
  await Promise.resolve()
  t.mock.timers.tick(4_000)
  controller.enqueue(new TextEncoder().encode("continued"))
  await Promise.resolve()
  t.mock.timers.tick(1_000)
  await rejected
  assert.equal(cancelled, true)
})

test("取消请求会终止等待JSON正文", async () => {
  const abort = new AbortController()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const parsing = readJson(jsonStream(stream, {}, abort.signal))
  const rejected = assert.rejects(parsing, invalidJson)
  abort.abort()
  await rejected
  assert.equal(cancelled, true)
})
