import type { PoolClient } from "pg"
import { withTransaction } from "./database"
import { AccountError, invalidInput } from "./auth/errors"

export type GenerationSlotStatus = "active" | "finished" | "unknown"
export type GenerationSlotInput = { userId: string; requestId: string; fingerprint: string }
export type GenerationSlotResult = { acquired: boolean; status: GenerationSlotStatus }

// 账号行锁在前，全局受理锁在后；上层可以先锁账号并复核会话，再复用本事务。
// 只覆盖计数和登记，不跨模型请求或 COS 上传持有连接。
const ADMISSION_LOCK = 1_909_961_702
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FINGERPRINT = /^[0-9a-f]{64}$/i

function boundedLimit(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) {
    throw new AccountError("GENERATION_CONFIGURATION_INVALID", 503, "生成保护配置无效，请联系管理员。")
  }
  return Number(raw)
}

function admissionLimits() {
  const concurrent = boundedLimit("IMAGE_GENERATION_MAX_CONCURRENT", 2, 8)
  return {
    concurrent,
    perUser: boundedLimit("IMAGE_GENERATION_PER_USER_CONCURRENT", 1, concurrent),
    perMinute: boundedLimit("IMAGE_GENERATION_RATE_PER_MINUTE", 6, 60),
  }
}

function validateRequest(userId: unknown, requestId: unknown): asserts userId is string {
  if (typeof userId !== "string" || !userId || typeof requestId !== "string" || !UUID.test(requestId)) {
    throw invalidInput("生成请求标识无效，请重新提交。")
  }
}

function safeAdmissionError(error: unknown): never {
  if (error instanceof AccountError) throw error
  throw new AccountError("GENERATION_ADMISSION_UNAVAILABLE", 503, "暂时无法受理生成请求，请稍后重试。")
}

/**
 * 仅供服务端调用，userId 必须来自已校验的入口身份。
 * 调用者必须已 BEGIN，并在同一事务内复核会话；本函数再次锁定并检查账号状态。
 * acquired=true 才可首次调用模型；false 包括超过 deadline 的旧请求，不能自动重发。
 */
export async function acquireGenerationSlotInTransaction(client: PoolClient, input: GenerationSlotInput): Promise<GenerationSlotResult> {
  try {
    validateRequest(input?.userId, input?.requestId)
    if (typeof input.fingerprint !== "string" || !FINGERPRINT.test(input.fingerprint)) {
      throw invalidInput("生成请求指纹无效，请重新提交。")
    }
    const limits = admissionLimits()
    const { userId } = input
    const requestId = input.requestId.toLowerCase()
    const fingerprint = input.fingerprint.toLowerCase()
    const { rows: [user] } = await client.query<{ banned: boolean; mustChangePassword: boolean }>(
      'SELECT banned,"mustChangePassword" FROM app."user" WHERE id=$1 FOR UPDATE', [userId],
    )
    if (!user || user.banned) throw new AccountError("UNAUTHENTICATED", 401, "请重新登录。")
    if (user.mustChangePassword) throw new AccountError("PASSWORD_CHANGE_REQUIRED", 403, "请先修改临时密码。")

    const { rows: [existing] } = await client.query<{ fingerprint: string; status: GenerationSlotStatus }>(
      'SELECT fingerprint,status FROM app.provider_request_slots WHERE "userId"=$1 AND "requestId"=$2',
      [userId, requestId],
    )
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AccountError("GENERATION_REQUEST_CONFLICT", 409, "该请求标识已用于其他生成内容，请使用新的请求。")
      }
      return { acquired: false, status: existing.status }
    }

    await client.query("SELECT pg_advisory_xact_lock($1)", [ADMISSION_LOCK])
    // statement_timestamp 使用取得锁之后的语句时刻，不使用事务开始时的 now()。
    const { rows: [counts] } = await client.query<{ active: number; userActive: number; recent: number }>(
      `SELECT
         count(*) FILTER (WHERE status IN ('active','unknown') AND "deadlineAt">statement_timestamp())::integer AS active,
         count(*) FILTER (WHERE "userId"=$1 AND status IN ('active','unknown') AND "deadlineAt">statement_timestamp())::integer AS "userActive",
         count(*) FILTER (WHERE "userId"=$1 AND "acceptedAt">statement_timestamp()-interval '60 seconds')::integer AS recent
       FROM app.provider_request_slots
       WHERE (status IN ('active','unknown') AND "deadlineAt">statement_timestamp())
          OR ("userId"=$1 AND "acceptedAt">statement_timestamp()-interval '60 seconds')`,
      [userId],
    )
    if (counts.active >= limits.concurrent || counts.userActive >= limits.perUser) {
      throw new AccountError("GENERATION_CONCURRENCY_LIMITED", 429, "已有生成任务处理中，请稍后重试。")
    }
    if (counts.recent >= limits.perMinute) {
      throw new AccountError("GENERATION_RATE_LIMITED", 429, "生成请求过于频繁，请一分钟后重试。")
    }
    await client.query(
      'INSERT INTO app.provider_request_slots ("userId","requestId",fingerprint) VALUES ($1,$2,$3)',
      [userId, requestId, fingerprint],
    )
    return { acquired: true, status: "active" }
  } catch (error) { return safeAdmissionError(error) }
}

export async function acquireGenerationSlot(input: GenerationSlotInput): Promise<GenerationSlotResult> {
  try {
    return await withTransaction((client) => acquireGenerationSlotInTransaction(client, input))
  } catch (error) { return safeAdmissionError(error) }
}

/** 仅在调用结果及保存状态已明确时传 finished；unknown 不被迟到结果重新释放。 */
export async function finishGenerationSlotInTransaction(
  client: PoolClient, userId: string, requestId: string, outcome: "finished" | "unknown",
): Promise<void> {
  try {
    validateRequest(userId, requestId)
    if (outcome !== "finished" && outcome !== "unknown") throw invalidInput("生成结果状态无效。")
    // 完成时允许账号已禁用，释放本次真实终态；只修改指定账号、指定请求的 active 行。
    // unknown 和 finished 都是不可覆盖的终态，缺失请求或重复完成没有副作用。
    await client.query(
      `UPDATE app.provider_request_slots SET status=$3
       WHERE "userId"=$1 AND "requestId"=$2 AND status='active'`,
      [userId, requestId.toLowerCase(), outcome],
    )
  } catch (error) { safeAdmissionError(error) }
}

export async function finishGenerationSlot(userId: string, requestId: string, outcome: "finished" | "unknown"): Promise<void> {
  try {
    await withTransaction((client) => finishGenerationSlotInTransaction(client, userId, requestId, outcome))
  } catch (error) { safeAdmissionError(error) }
}
