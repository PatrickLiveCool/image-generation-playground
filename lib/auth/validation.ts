import { AccountError, invalidInput } from "./errors"

const MAX_JSON_BYTES = 16_384
const JSON_READ_TIMEOUT_MS = 5_000

export function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") throw invalidInput("用户名须为 3–32 位字母、数字、下划线或短横线。")
  const username = value.trim().toLowerCase()
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) throw invalidInput("用户名须为 3–32 位字母、数字、下划线或短横线。")
  return username
}

export function validateName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw invalidInput("姓名须为 1–80 个字符。")
  return value.trim()
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128) throw invalidInput("密码须为 12–128 个字符。")
  return value
}

export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) throw invalidInput()
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "") || !request.body) throw invalidInput()
  const reader = request.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  const declaredLength = request.headers.get("content-length")
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    cancel()
    reader.releaseLock()
    throw invalidInput()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const deadline = Date.now() + JSON_READ_TIMEOUT_MS
  const timeout = () => new AccountError("REQUEST_TIMEOUT", 408, "请求读取超时，请重试。")
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeout()), JSON_READ_TIMEOUT_MS)
    abort = () => reject(invalidInput("请求已取消。"))
    request.signal.addEventListener("abort", abort, { once: true })
    if (request.signal.aborted) abort()
  })
  const chunks: Uint8Array[] = []
  let bytes = 0
  let chunkCount = 0
  let text: string
  try {
    for (;;) {
      // Even an endless sequence of immediately resolved empty chunks must stop.
      if (Date.now() >= deadline) throw timeout()
      const { done, value } = await Promise.race([reader.read(), stopped])
      if (done) break
      if (++chunkCount > maxBytes) throw invalidInput()
      bytes += value.byteLength
      if (bytes > maxBytes) throw invalidInput()
      if (value.byteLength) chunks.push(value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    text = new TextDecoder("utf-8", { fatal: true }).decode(body)
  } catch (error) {
    // Cancellation can be backed by an uncooperative stream. Never await it.
    cancel()
    if (error instanceof AccountError) throw error
    throw invalidInput()
  } finally {
    clearTimeout(timer)
    if (abort) request.signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput()
    return value as Record<string, unknown>
  } catch { throw invalidInput() }
}
