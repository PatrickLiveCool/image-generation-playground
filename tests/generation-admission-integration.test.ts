import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { AccountError } from "../lib/auth/errors"
import { closeDatabase, getDatabase, withTransaction } from "../lib/database"
import { acquireGenerationSlot, acquireGenerationSlotInTransaction, finishGenerationSlot } from "../lib/generation-admission"
import { assertAccountTestFixture } from "../scripts/database/test-fixture"

const testUrl = process.env.IMAGE_ADMISSION_TEST_DATABASE_URL
if (!testUrl) throw new Error("Set IMAGE_ADMISSION_TEST_DATABASE_URL to the dedicated local acceptance fixture; this suite never uses default credentials")
const parsed = new URL(testUrl)
if (parsed.hostname !== "127.0.0.1" || parsed.port !== "32768" || parsed.pathname !== "/qintopia_image" || parsed.username !== "qintopia_image_app") throw new Error("Admission tests require the fixed local acceptance fixture")
process.env.IMAGE_DATABASE_URL = testUrl
process.env.IMAGE_DATABASE_TARGET = "local"

const variables = ["IMAGE_GENERATION_MAX_CONCURRENT", "IMAGE_GENERATION_PER_USER_CONCURRENT", "IMAGE_GENERATION_RATE_PER_MINUTE"] as const
function configure(concurrent?: number, perUser?: number, rate?: number) {
  for (const [index, value] of [concurrent, perUser, rate].entries()) {
    if (value === undefined) delete process.env[variables[index]]
    else process.env[variables[index]] = String(value)
  }
}
function request(userId: string) { return { userId, requestId: randomUUID(), fingerprint: "ab".repeat(32) } }
function code(expected: string) { return (error: unknown) => error instanceof AccountError && error.code === expected }

test("真实PostgreSQL受理并发、额度、幂等与账号锁", async (t) => {
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]))
  const pool = await getDatabase()
  const users = [randomUUID(), randomUUID()]
  const usernames = ["admission_test_user_a", "admission_test_user_b"]
  let inserted = false
  async function clearSlots() {
    await assertAccountTestFixture(pool)
    await pool.query('DELETE FROM app.provider_request_slots WHERE "userId"=ANY($1::text[])', [users])
    configure()
  }
  async function countRows() {
    return (await pool.query('SELECT count(*)::integer AS total FROM app.provider_request_slots WHERE "userId"=ANY($1::text[])', [users])).rows[0].total
  }
  t.after(async () => {
    try {
      if (inserted) {
        await assertAccountTestFixture(pool)
        await pool.query('DELETE FROM app."user" WHERE id=ANY($1::text[]) AND username=ANY($2::text[])', [users, usernames])
      }
    } finally {
      for (const name of variables) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
      }
      await closeDatabase()
    }
  })
  await assertAccountTestFixture(pool)
  // 精确用户名用于夹具清单，随机ID限定本轮所有写入/清理；冲突时失败，不清除其他轮次。
  await pool.query(
    'INSERT INTO app."user" (id,name,email,username,"mustChangePassword") SELECT id,$3,id||\'@accounts.invalid\',username,false FROM unnest($1::text[],$2::text[]) AS fixture(id,username)',
    [users, usernames, "合成受理测试账号"],
  )
  inserted = true

  await t.test("默认16个同用户并发只受理1个，拒绝不消耗额度", async () => {
    await clearSlots()
    const attempts = await Promise.allSettled(Array.from({ length: 16 }, () => acquireGenerationSlot(request(users[0]))))
    assert.equal(attempts.filter((item) => item.status === "fulfilled" && item.value.acquired).length, 1)
    assert.equal(attempts.filter((item) => item.status === "rejected" && code("GENERATION_CONCURRENCY_LIMITED")(item.reason)).length, 15)
    assert.equal(await countRows(), 1)
  })

  await t.test("16并发在服务端下限1和上限8均不超过配置", async () => {
    for (const limit of [1, 8]) {
      await clearSlots()
      configure(limit, limit, 60)
      const attempts = await Promise.allSettled(Array.from({ length: 16 }, () => acquireGenerationSlot(request(users[0]))))
      assert.equal(attempts.filter((item) => item.status === "fulfilled" && item.value.acquired).length, limit)
      assert.equal(attempts.filter((item) => item.status === "rejected" && code("GENERATION_CONCURRENCY_LIMITED")(item.reason)).length, 16 - limit)
      assert.equal(await countRows(), limit)
    }
  })

  await t.test("不同用户16并发共同受全局2限制", async () => {
    await clearSlots()
    configure(2, 2, 60)
    const attempts = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => acquireGenerationSlot(request(users[index % 2]))))
    assert.equal(attempts.filter((item) => item.status === "fulfilled" && item.value.acquired).length, 2)
    assert.equal(attempts.filter((item) => item.status === "rejected" && code("GENERATION_CONCURRENCY_LIMITED")(item.reason)).length, 14)
    assert.equal(await countRows(), 2)
  })

  await t.test("同id16次并发只受理1次，同id不同内容409且不新增记录", async () => {
    await clearSlots()
    const input = request(users[0])
    const attempts = await Promise.all(Array.from({ length: 16 }, () => acquireGenerationSlot(input)))
    assert.equal(attempts.filter((item) => item.acquired).length, 1)
    assert.equal(attempts.filter((item) => !item.acquired && item.status === "active").length, 15)
    await assert.rejects(acquireGenerationSlot({ ...input, fingerprint: "cd".repeat(32) }), code("GENERATION_REQUEST_CONFLICT"))
    assert.equal(await countRows(), 1)
    await finishGenerationSlot(input.userId, input.requestId, "finished")
    await finishGenerationSlot(input.userId, input.requestId, "unknown")
    assert.deepEqual(await acquireGenerationSlot(input), { acquired: false, status: "finished" })
    assert.equal(await countRows(), 1)
  })

  await t.test("同requestId按用户隔离，完成操作不会释放其他账号任务", async () => {
    await clearSlots()
    const input = request(users[0])
    const other = { ...input, userId: users[1] }
    assert.equal((await acquireGenerationSlot(input)).acquired, true)
    assert.equal((await acquireGenerationSlot(other)).acquired, true)
    await finishGenerationSlot(input.userId, input.requestId, "finished")
    assert.deepEqual(await acquireGenerationSlot(other), { acquired: false, status: "active" })
    await assert.rejects(acquireGenerationSlot(request(users[1])), code("GENERATION_CONCURRENCY_LIMITED"))
    assert.equal((await acquireGenerationSlot(request(users[0]))).acquired, true)
  })

  await t.test("默认每分钟6次仅首次受理消耗，另一个账号有独立额度", async () => {
    await clearSlots()
    const accepted = []
    for (let index = 0; index < 6; index += 1) {
      const input = request(users[0])
      accepted.push(input)
      assert.equal((await acquireGenerationSlot(input)).acquired, true)
      await finishGenerationSlot(input.userId, input.requestId, "finished")
      assert.deepEqual(await acquireGenerationSlot(input), { acquired: false, status: "finished" })
    }
    await assert.rejects(acquireGenerationSlot(request(users[0])), code("GENERATION_RATE_LIMITED"))
    assert.equal(await countRows(), 6)
    assert.deepEqual(await acquireGenerationSlot(accepted[0]), { acquired: false, status: "finished" })
    assert.equal((await acquireGenerationSlot(request(users[1]))).acquired, true)
    await pool.query('UPDATE app.provider_request_slots SET "acceptedAt"="acceptedAt"-interval \'61 seconds\',"deadlineAt"="deadlineAt"-interval \'61 seconds\' WHERE "userId"=$1', [users[0]])
    assert.equal((await acquireGenerationSlot(request(users[0]))).acquired, true)
  })

  await t.test("每分钟额度下限1与上限60在真实库生效", async () => {
    for (const rate of [1, 60]) {
      await clearSlots()
      configure(2, 1, rate)
      for (let index = 0; index < rate; index += 1) {
        const input = request(users[0])
        assert.equal((await acquireGenerationSlot(input)).acquired, true)
        await finishGenerationSlot(input.userId, input.requestId, "finished")
      }
      await assert.rejects(acquireGenerationSlot(request(users[0])), code("GENERATION_RATE_LIMITED"))
      assert.equal(await countRows(), rate)
    }
  })

  await t.test("unknown保留到300秒deadline，迟到结果和重复请求都不能立即释放", async () => {
    await clearSlots()
    const input = request(users[0])
    await acquireGenerationSlot(input)
    const before = (await pool.query('SELECT "acceptedAt","deadlineAt" FROM app.provider_request_slots WHERE "userId"=$1 AND "requestId"=$2', [input.userId, input.requestId])).rows[0]
    assert.equal(before.deadlineAt.getTime() - before.acceptedAt.getTime(), 300_000)
    await finishGenerationSlot(input.userId, input.requestId, "unknown")
    await finishGenerationSlot(input.userId, input.requestId, "finished")
    assert.deepEqual(await acquireGenerationSlot(input), { acquired: false, status: "unknown" })
    await assert.rejects(acquireGenerationSlot(request(users[0])), code("GENERATION_CONCURRENCY_LIMITED"))
    assert.deepEqual((await pool.query('SELECT "acceptedAt","deadlineAt" FROM app.provider_request_slots WHERE "userId"=$1 AND "requestId"=$2', [input.userId, input.requestId])).rows[0], before)
    await pool.query('UPDATE app.provider_request_slots SET "acceptedAt"="acceptedAt"-interval \'301 seconds\',"deadlineAt"="deadlineAt"-interval \'301 seconds\' WHERE "userId"=$1 AND "requestId"=$2', [input.userId, input.requestId])
    const next = request(users[0])
    assert.equal((await acquireGenerationSlot(next)).acquired, true)
    assert.deepEqual(await acquireGenerationSlot(input), { acquired: false, status: "unknown" })
    await finishGenerationSlot(input.userId, input.requestId, "finished")
    assert.deepEqual(await acquireGenerationSlot(next), { acquired: false, status: "active" })
    await assert.rejects(acquireGenerationSlot(request(users[0])), code("GENERATION_CONCURRENCY_LIMITED"))
  })

  await t.test("过期active释放并发但不能以原id重新受理", async () => {
    await clearSlots()
    const input = request(users[0])
    await acquireGenerationSlot(input)
    await pool.query('UPDATE app.provider_request_slots SET "acceptedAt"="acceptedAt"-interval \'301 seconds\',"deadlineAt"="deadlineAt"-interval \'301 seconds\' WHERE "userId"=$1 AND "requestId"=$2', [input.userId, input.requestId])
    assert.deepEqual(await acquireGenerationSlot(input), { acquired: false, status: "active" })
    assert.equal((await acquireGenerationSlot(request(users[0]))).acquired, true)
    assert.equal(await countRows(), 2)
  })

  await t.test("底层函数加入调用者事务，后续run创建失败整体回滚且不消耗额度", async () => {
    await clearSlots()
    const input = request(users[0])
    await assert.rejects(withTransaction(async (client) => {
      assert.equal((await acquireGenerationSlotInTransaction(client, input)).acquired, true)
      throw new Error("合成run写入失败")
    }), /合成run写入失败/)
    assert.equal(await countRows(), 0)
    assert.equal((await acquireGenerationSlot(input)).acquired, true)
  })

  await t.test("账号禁用、临时密码和未知userId拒绝，重复请求仍复核账号", async () => {
    await clearSlots()
    const input = request(users[0])
    await acquireGenerationSlot(input)
    await pool.query('UPDATE app."user" SET banned=true WHERE id=$1', [users[0]])
    await assert.rejects(acquireGenerationSlot(input), code("UNAUTHENTICATED"))
    await assert.rejects(acquireGenerationSlot(request(users[0])), code("UNAUTHENTICATED"))
    await finishGenerationSlot(input.userId, input.requestId, "finished")
    await pool.query('UPDATE app."user" SET banned=false,"mustChangePassword"=true WHERE id=$1', [users[0]])
    await assert.rejects(acquireGenerationSlot(request(users[0])), code("PASSWORD_CHANGE_REQUIRED"))
    await assert.rejects(acquireGenerationSlot(request(randomUUID())), code("UNAUTHENTICATED"))
    await pool.query('UPDATE app."user" SET "mustChangePassword"=false WHERE id=$1', [users[0]])
    assert.equal(await countRows(), 1)
  })

  await t.test("受理等待账号行锁后看到已提交禁用，不能使用旧启用状态", async () => {
    await clearSlots()
    const blocker = await pool.connect()
    const acquirer = await pool.connect()
    let attempt: Promise<unknown> | undefined
    try {
      await blocker.query("BEGIN")
      await blocker.query('UPDATE app."user" SET banned=true WHERE id=$1', [users[0]])
      await acquirer.query("BEGIN")
      const pid = (await acquirer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid
      attempt = assert.rejects(acquireGenerationSlotInTransaction(acquirer, request(users[0])), code("UNAUTHENTICATED"))
      let waiting = false
      for (let iteration = 0; iteration < 100 && !waiting; iteration += 1) {
        waiting = Boolean((await pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted", [pid])).rowCount)
        if (!waiting) await delay(10)
      }
      assert.equal(waiting, true, "受理必须等待禁用事务的账号行锁")
      await blocker.query("COMMIT")
      await attempt
    } finally {
      try {
        await blocker.query("ROLLBACK")
        if (attempt) await attempt.catch(() => {})
      } finally {
        await acquirer.query("ROLLBACK")
        blocker.release()
        acquirer.release()
        await pool.query('UPDATE app."user" SET banned=false WHERE id=$1', [users[0]])
      }
    }
    assert.equal(await countRows(), 0)
  })
})
