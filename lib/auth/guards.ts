import type { PoolClient } from "pg"
import type { AccountUser } from "../account-types"
import { getDatabase } from "../database"
import { authConfiguration } from "./config"
import { AccountError } from "./errors"
import { getAuth } from "./server"

export { AccountError, accountErrorResponse } from "./errors"
export type AccountOptions = { admin?: boolean; allowPasswordChange?: boolean }
export type AccountIdentity = { user: AccountUser; sessionId: string; sessionToken: string }

export function assertSameOrigin(request: Request) {
  if (request.headers.get("origin") !== authConfiguration().origin) {
    throw new AccountError("FORBIDDEN", 403, "请求来源不受信任，请刷新页面后重试。")
  }
}

export function checkAccount(user: AccountUser & { banned?: boolean }, options: AccountOptions = {}) {
  if (user.banned || (user.role !== "admin" && user.role !== "user")) throw new AccountError("UNAUTHENTICATED", 401, "请重新登录。")
  if (user.mustChangePassword && !options.allowPasswordChange) throw new AccountError("PASSWORD_CHANGE_REQUIRED", 403, "请先修改临时密码。")
  if (options.admin && user.role !== "admin") throw new AccountError("FORBIDDEN", 403, "需要管理员权限。")
}

export async function accountIdentity(headers: Headers, options: AccountOptions = {}): Promise<AccountIdentity> {
  const auth = await getAuth()
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (!session) throw new AccountError("UNAUTHENTICATED", 401, "请重新登录。")
  const pool = await getDatabase()
  const { rows: [user] } = await pool.query<AccountUser & { banned: boolean }>(
    'SELECT u.id,u.username,u.name,u.role,u.banned,u."mustChangePassword" FROM app."user" u JOIN app.session s ON s."userId"=u.id WHERE s.id=$1 AND s.token=$2 AND s."expiresAt">now()',
    [session.session.id, session.session.token],
  )
  if (!user) throw new AccountError("UNAUTHENTICATED", 401, "请重新登录。")
  checkAccount(user, options)
  return { user: safeUser(user), sessionId: session.session.id, sessionToken: session.session.token }
}

export function safeUser(user: AccountUser): AccountUser {
  return { id: user.id, username: user.username, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword }
}

export async function requireAccount(headers: Headers, options: AccountOptions = {}): Promise<AccountUser> {
  return (await accountIdentity(headers, options)).user
}

// Call only after acquiring the affected user lock(s). Rechecking both the
// account and session inside the write transaction prevents stale authorization.
export async function recheckAccount(client: PoolClient, identity: AccountIdentity, options: AccountOptions = {}): Promise<AccountUser> {
  const { rows: [user] } = await client.query<AccountUser & { banned: boolean }>(
    'SELECT id,username,name,role,banned,"mustChangePassword" FROM app."user" WHERE id=$1 FOR UPDATE', [identity.user.id],
  )
  if (!user) throw new AccountError("UNAUTHENTICATED", 401, "请重新登录。")
  checkAccount(user, options)
  const { rowCount } = await client.query('SELECT id FROM app.session WHERE id=$1 AND token=$2 AND "userId"=$3 AND "expiresAt">now()', [identity.sessionId, identity.sessionToken, user.id])
  if (!rowCount) throw new AccountError("UNAUTHENTICATED", 401, "请重新登录。")
  return safeUser(user)
}
