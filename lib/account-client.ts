import type {
  AccountAction,
  AccountSession,
  AccountUser,
  AccountUsersPage,
  AdminAccountUser,
  TemporaryPassword,
} from "@/lib/account-types"

export const ACCOUNT_SESSION_CHANNEL = "qintopia-image-account-session"
export const ACCOUNT_SESSION_RECHECK_EVENT = "qintopia-image-account-recheck"
export const ACCOUNT_REQUEST_TIMEOUT_MS = 15_000

export class AccountRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = "AccountRequestError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isUser(value: unknown): value is AccountUser {
  return record(value) && typeof value.id === "string" && typeof value.username === "string"
    && typeof value.name === "string" && (value.role === "admin" || value.role === "user")
    && typeof value.mustChangePassword === "boolean"
}

function invalidResponse(): never {
  throw new AccountRequestError("服务器响应未能确认，请刷新页面核对后再操作。", 0, "INVALID_RESPONSE")
}

async function request(path: string, options: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController()
  const callerSignal = options.signal
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      controller.abort()
      reject(new DOMException("The operation was aborted.", "AbortError"))
    }
    if (callerSignal?.aborted) onAbort()
    else callerSignal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new AccountRequestError("请求超时，操作结果尚未确认。请重新检查后再操作。", 0, "REQUEST_TIMEOUT"))
    }, ACCOUNT_REQUEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([cancelled, (async () => {
      if (callerSignal?.aborted) throw new DOMException("The operation was aborted.", "AbortError")
      const response = await fetch(path, {
        ...options,
        signal: controller.signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Cache-Control": "no-store",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      })
      // The deadline covers both headers and the complete response body.
      const value: unknown = await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return null
        throw error
      })
      if (!response.ok) {
        const detail = record(value) && record(value.error) ? value.error : null
        throw new AccountRequestError(
          detail && typeof detail.message === "string" ? detail.message : "操作未完成，请稍后重试。",
          response.status,
          detail && typeof detail.code === "string" ? detail.code : "REQUEST_FAILED",
        )
      }
      return value
    })()])
  } catch (error) {
    if (timedOut) throw new AccountRequestError("请求超时，操作结果尚未确认。请重新检查后再操作。", 0, "REQUEST_TIMEOUT")
    if (error instanceof AccountRequestError) throw error
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new AccountRequestError("网络连接中断，操作结果尚未确认。请重新检查后再操作。", 0, "NETWORK_ERROR")
  } finally {
    clearTimeout(timer)
    if (onAbort) callerSignal?.removeEventListener("abort", onAbort)
  }
}

export function accountErrorMessage(error: unknown): string {
  return error instanceof AccountRequestError ? error.message : "操作未完成，请稍后重试。"
}

export function notifyAccountSessionChanged(): void {
  if (typeof BroadcastChannel === "undefined") return
  const channel = new BroadcastChannel(ACCOUNT_SESSION_CHANNEL)
  channel.postMessage("session-changed")
  channel.close()
}

export async function getAccountSession(signal?: AbortSignal): Promise<AccountSession> {
  const value = await request("/api/account/session", { signal })
  if (!record(value) || !(value.user === null || isUser(value.user))) invalidResponse()
  return { user: value.user as AccountUser | null }
}

export async function signInAccount(username: string, password: string): Promise<AccountSession> {
  try {
    await request("/api/auth/sign-in/username", {
      method: "POST",
      body: JSON.stringify({ username: username.trim(), password }),
    })
  } catch (error) {
    if (error instanceof AccountRequestError && error.status >= 400 && error.status < 500) {
      throw new AccountRequestError(
        error.status === 429 ? "尝试过于频繁，请稍后再登录。" : "登录失败，请检查用户名和密码，或联系管理员。",
        error.status,
        "SIGN_IN_FAILED",
      )
    }
    throw new AccountRequestError("登录请求的结果尚未确认，请重新检查登录状态。请勿重复提交一次性临时密码。", 0, "SIGN_IN_UNCONFIRMED")
  }
  // 登录响应不作为身份依据：必须重新取得当前服务端会话。
  notifyAccountSessionChanged()
  try {
    const session = await getAccountSession()
    if (!session.user) throw new Error("Session not yet confirmed")
    return session
  } catch {
    throw new AccountRequestError("登录请求已提交，但当前会话尚未确认。请重新检查登录状态，勿重复使用临时密码。", 0, "SIGN_IN_UNCONFIRMED")
  }
}

export async function signOutAccount(): Promise<void> {
  await request("/api/auth/sign-out", { method: "POST", body: JSON.stringify({}) })
  notifyAccountSessionChanged()
}

export async function changeAccountPassword(currentPassword: string, newPassword: string): Promise<void> {
  const value = await request("/api/account/password", {
    method: "POST", body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!record(value) || value.ok !== true) invalidResponse()
  notifyAccountSessionChanged()
}

export async function listAccounts(offset = 0, signal?: AbortSignal): Promise<AccountUsersPage> {
  const value = await request(`/api/admin/users?limit=25&offset=${offset}`, { signal })
  if (!record(value) || !Array.isArray(value.users)
    || !value.users.every((user) => isUser(user) && typeof (user as AdminAccountUser).banned === "boolean"
      && typeof (user as AdminAccountUser).createdAt === "string")
    || typeof value.total !== "number" || typeof value.limit !== "number" || typeof value.offset !== "number") invalidResponse()
  return value as AccountUsersPage
}

function readTemporaryPassword(value: unknown): TemporaryPassword {
  if (!record(value) || typeof value.temporaryPassword !== "string" || !value.temporaryPassword
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) invalidResponse()
  return { temporaryPassword: value.temporaryPassword, expiresAt: value.expiresAt }
}

export async function createAccount(username: string, name: string): Promise<{ user: AccountUser } & TemporaryPassword> {
  const value = await request("/api/admin/users", {
    method: "POST", body: JSON.stringify({ username: username.trim(), name: name.trim() }),
  })
  if (!record(value) || !isUser(value.user)) invalidResponse()
  return { user: value.user, ...readTemporaryPassword(value) }
}

export async function updateAccount(id: string, action: AccountAction): Promise<TemporaryPassword | null> {
  const value = await request(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: "POST", body: JSON.stringify({ action }),
  })
  if (!record(value) || value.ok !== true) invalidResponse()
  return action === "reset-password" ? readTemporaryPassword(value) : null
}
