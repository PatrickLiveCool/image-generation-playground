import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import type { PoolClient } from "pg"
import { AccountError, accountErrorResponse } from "../lib/auth/errors"
import { acquireGenerationSlotInTransaction, finishGenerationSlotInTransaction, type GenerationSlotInput } from "../lib/generation-admission"

const variables = ["IMAGE_GENERATION_MAX_CONCURRENT", "IMAGE_GENERATION_PER_USER_CONCURRENT", "IMAGE_GENERATION_RATE_PER_MINUTE"] as const
type Limits = Partial<Record<(typeof variables)[number], string>>

async function configured(limits: Limits, action: () => Promise<void>) {
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]))
  for (const name of variables) {
    if (limits[name] === undefined) delete process.env[name]
    else process.env[name] = limits[name]
  }
  try { await action() } finally {
    for (const name of variables) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
}

function fakeClient(options: {
  counts?: { active: number; userActive: number; recent: number }
  user?: { banned: boolean; mustChangePassword: boolean } | null
  existing?: { fingerprint: string; status: "active" | "finished" | "unknown" }
  fail?: Error
} = {}) {
  const queries: { sql: string; values: unknown[] }[] = []
  return {
    queries,
    client: {
      async query(sql: string, values: unknown[] = []) {
        queries.push({ sql, values })
        if (options.fail) throw options.fail
        if (sql.startsWith("SELECT banned")) return { rows: options.user === null ? [] : [options.user ?? { banned: false, mustChangePassword: false }] }
        if (sql.startsWith("SELECT fingerprint")) return { rows: options.existing ? [options.existing] : [] }
        if (sql.includes("AS active")) return { rows: [options.counts ?? { active: 0, userActive: 0, recent: 0 }] }
        return { rows: [] }
      },
    } as unknown as PoolClient,
  }
}
function request(): GenerationSlotInput { return { userId: "synthetic-existing-user", requestId: randomUUID(), fingerprint: "ab".repeat(32) } }
function code(expected: string) { return (error: unknown) => error instanceof AccountError && error.code === expected }

test("受理默认全局2、单用户1、每分钟6，不采纳请求附带阈值", async () => {
  await configured({}, async () => {
    const injected = { ...request(), concurrent: 99, perUser: 99, perMinute: 99 }
    for (const counts of [{ active: 2, userActive: 0, recent: 0 }, { active: 1, userActive: 1, recent: 1 }]) {
      await assert.rejects(acquireGenerationSlotInTransaction(fakeClient({ counts }).client, injected), code("GENERATION_CONCURRENCY_LIMITED"))
    }
    await assert.rejects(acquireGenerationSlotInTransaction(fakeClient({ counts: { active: 0, userActive: 0, recent: 6 } }).client, injected), code("GENERATION_RATE_LIMITED"))
    assert.deepEqual(await acquireGenerationSlotInTransaction(fakeClient({ counts: { active: 1, userActive: 0, recent: 5 } }).client, request()), { acquired: true, status: "active" })
  })
})

test("阈值允许下调与有限上调，非法值在数据库查询前拒绝", async () => {
  for (const limits of [
    { IMAGE_GENERATION_MAX_CONCURRENT: "1", IMAGE_GENERATION_PER_USER_CONCURRENT: "1", IMAGE_GENERATION_RATE_PER_MINUTE: "1" },
    { IMAGE_GENERATION_MAX_CONCURRENT: "8", IMAGE_GENERATION_PER_USER_CONCURRENT: "8", IMAGE_GENERATION_RATE_PER_MINUTE: "60" },
  ]) {
    await configured(limits, async () => {
      assert.equal((await acquireGenerationSlotInTransaction(fakeClient().client, request())).acquired, true)
    })
  }
  for (const limits of [
    ...["0", "9", "-1", "1.5", "NaN", "Infinity", "1e1", "", " 2", "02", "9007199254740993"].map((value) => ({ IMAGE_GENERATION_MAX_CONCURRENT: value })),
    { IMAGE_GENERATION_PER_USER_CONCURRENT: "3" },
    { IMAGE_GENERATION_MAX_CONCURRENT: "1", IMAGE_GENERATION_PER_USER_CONCURRENT: "2" },
    { IMAGE_GENERATION_RATE_PER_MINUTE: "61" },
    { IMAGE_GENERATION_RATE_PER_MINUTE: "0" },
  ]) {
    await configured(limits, async () => {
      const mocked = fakeClient()
      await assert.rejects(acquireGenerationSlotInTransaction(mocked.client, request()), code("GENERATION_CONFIGURATION_INVALID"))
      assert.equal(mocked.queries.length, 0)
    })
  }
})

test("请求标识和指纹严格校验，无效请求不执行SQL", async () => {
  for (const input of [null, {}, { ...request(), userId: "" }, { ...request(), requestId: "not-a-uuid" }, { ...request(), requestId: randomUUID() + " " }, { ...request(), fingerprint: "x".repeat(64) }, { ...request(), fingerprint: "a".repeat(63) }, { ...request(), fingerprint: "a".repeat(65) }]) {
    const mocked = fakeClient()
    await assert.rejects(acquireGenerationSlotInTransaction(mocked.client, input as GenerationSlotInput), code("INVALID_INPUT"))
    assert.equal(mocked.queries.length, 0)
  }
})

test("缺失、禁用和临时账号即使重复请求也不能受理", async () => {
  await configured({}, async () => {
    for (const user of [null, { banned: true, mustChangePassword: false }, { banned: false, mustChangePassword: true }]) {
      const mocked = fakeClient({ user, existing: { fingerprint: "ab".repeat(32), status: "finished" } })
      await assert.rejects(acquireGenerationSlotInTransaction(mocked.client, request()), code(user?.mustChangePassword ? "PASSWORD_CHANGE_REQUIRED" : "UNAUTHENTICATED"))
      assert.equal(mocked.queries.length, 1)
    }
  })
})

test("所有既存状态都返回acquired=false，指纹冲突返回409", async () => {
  await configured({}, async () => {
    for (const status of ["active", "finished", "unknown"] as const) {
      const input = request()
      const mocked = fakeClient({ existing: { fingerprint: input.fingerprint, status } })
      assert.deepEqual(await acquireGenerationSlotInTransaction(mocked.client, { ...input, requestId: input.requestId.toUpperCase(), fingerprint: input.fingerprint.toUpperCase() }), { acquired: false, status })
      assert.equal(mocked.queries.length, 2, "重复请求不进入额度统计或写入")
      await assert.rejects(acquireGenerationSlotInTransaction(mocked.client, { ...input, fingerprint: "cc".repeat(32) }), (error: unknown) => error instanceof AccountError && error.status === 409 && error.code === "GENERATION_REQUEST_CONFLICT")
    }
  })
})

test("数据库错误仅暴露稳定安全JSON，不返回SQL或凭证", async () => {
  await configured({}, async () => {
    const mocked = fakeClient({ fail: new Error("SQL SELECT private_token FROM secret: synthetic-password") })
    for (const operation of [
      () => acquireGenerationSlotInTransaction(mocked.client, request()),
      () => finishGenerationSlotInTransaction(mocked.client, "synthetic-owner", randomUUID(), "finished"),
    ]) {
      let caught: unknown
      try { await operation() } catch (error) { caught = error }
      assert.ok(caught instanceof AccountError)
      const response = accountErrorResponse(caught)
      assert.equal(response.status, 503)
      const serialized = await response.text()
      assert.match(serialized, /GENERATION_ADMISSION_UNAVAILABLE/)
      assert.doesNotMatch(serialized, /SQL|private_token|synthetic-password/)
    }
  })
})

test("完成操作拒绝未知状态或请求标识，不发SQL", async () => {
  const mocked = fakeClient()
  await assert.rejects(finishGenerationSlotInTransaction(mocked.client, "synthetic-owner", randomUUID(), "active" as "finished"), code("INVALID_INPUT"))
  await assert.rejects(finishGenerationSlotInTransaction(mocked.client, "synthetic-owner", "invalid", "finished"), code("INVALID_INPUT"))
  assert.equal(mocked.queries.length, 0)
})
