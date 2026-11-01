import { randomBytes } from "node:crypto"
import { hashPassword, verifyPassword } from "better-auth/crypto"
import type { PoolClient } from "pg"
import type { AccountUser, AdminAccountUser } from "../account-types"
import { withTransaction } from "../database"
import { AccountError, invalidInput } from "./errors"
import { accountIdentity, recheckAccount, safeUser, type AccountIdentity } from "./guards"
import { normalizeUsername, validateName, validatePassword } from "./validation"
import { consumeAccountRateLimit } from "./rate-limit"
import { audit, insertAccount, lockAdministration } from "./account-writes"
import { initializeAdministrator } from "./bootstrap-administrator"
export { lockAdministration } from "./account-writes"

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505"
}

function temporaryCredential() {
  return { temporaryPassword: randomBytes(24).toString("base64url"), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
}

export async function bootstrapAdministrator(input: { username: unknown; name: unknown; password: unknown }) {
  return safeUser(await initializeAdministrator(input, withTransaction))
}

export async function createAccount(headers: Headers, input: Record<string, unknown>) {
  const identity = await accountIdentity(headers, { admin: true })
  const username = normalizeUsername(input.username)
  const name = validateName(input.name)
  await consumeAccountRateLimit("admin-password", identity.user.id)
  const credential = temporaryCredential()
  const passwordHash = await hashPassword(credential.temporaryPassword)
  try {
    const user = await withTransaction(async (client) => {
      await lockAdministration(client)
      await recheckAccount(client, identity, { admin: true })
      const user = await insertAccount(client, username, name, "user", passwordHash, credential.expiresAt)
      await audit(client, identity.user.id, user.id, "create-user")
      return user
    })
    return { user, ...credential }
  } catch (error) {
    if (isUniqueViolation(error)) throw new AccountError("USERNAME_TAKEN", 409, "用户名已存在；如需恢复账号，请明确执行重置密码。")
    throw error
  }
}

export async function listAccounts(headers: Headers, url: URL) {
  const identity = await accountIdentity(headers, { admin: true })
  const limit = Number(url.searchParams.get("limit") ?? "100")
  const offset = Number(url.searchParams.get("offset") ?? "0")
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw invalidInput("分页参数无效。")
  return withTransaction(async (client) => {
    await recheckAccount(client, identity, { admin: true })
    const { rows: users } = await client.query<AdminAccountUser>('SELECT id,username,name,role,banned,"mustChangePassword","createdAt" FROM app."user" ORDER BY "createdAt",id LIMIT $1 OFFSET $2', [limit, offset])
    const { rows: [count] } = await client.query<{ total: string }>('SELECT count(*) AS total FROM app."user"')
    return { users, total: Number(count.total), limit, offset }
  })
}

async function lockActorAndTarget(client: PoolClient, identity: AccountIdentity, targetId: string) {
  await lockAdministration(client)
  await client.query('SELECT id FROM app."user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [[identity.user.id, targetId]])
  await recheckAccount(client, identity, { admin: true })
  const { rows: [target] } = await client.query<AccountUser & { banned: boolean }>('SELECT id,username,name,role,banned,"mustChangePassword" FROM app."user" WHERE id=$1', [targetId])
  if (!target) throw new AccountError("ACCOUNT_NOT_FOUND", 404, "账号不存在。")
  return target
}

export async function manageAccount(headers: Headers, targetId: string, input: Record<string, unknown>) {
  const identity = await accountIdentity(headers, { admin: true })
  const action = input.action
  if (typeof action !== "string" || !["disable", "restore", "reset-password"].includes(action) || !targetId || targetId.length > 128) throw invalidInput()
  if (action === "reset-password") await consumeAccountRateLimit("admin-password", identity.user.id)
  const credential = action === "reset-password" ? temporaryCredential() : null
  const passwordHash = credential ? await hashPassword(credential.temporaryPassword) : null
  return withTransaction(async (client) => {
    const target = await lockActorAndTarget(client, identity, targetId)
    if (action !== "restore" && target.role === "admin" && !target.banned && !target.mustChangePassword) {
      const { rows: [count] } = await client.query<{ total: string }>('SELECT count(*) AS total FROM app."user" WHERE role=$1 AND banned=false AND "mustChangePassword"=false', ["admin"])
      if (Number(count.total) <= 1) throw new AccountError("LAST_ADMIN", 409, "不能禁用或重置最后一位可用管理员。")
    }
    if (action === "reset-password") {
      const { rowCount } = await client.query('UPDATE app.account SET password=$1,"updatedAt"=now() WHERE "userId"=$2 AND "providerId"=$3', [passwordHash, targetId, "credential"])
      if (rowCount !== 1) throw new Error("Credential account is unavailable")
      await client.query('UPDATE app."user" SET "mustChangePassword"=true,"temporaryPasswordExpiresAt"=$1,"temporaryPasswordUsedAt"=NULL,"updatedAt"=now() WHERE id=$2', [credential!.expiresAt, targetId])
    } else {
      await client.query('UPDATE app."user" SET banned=$1,"banReason"=NULL,"banExpires"=NULL,"updatedAt"=now() WHERE id=$2', [action === "disable", targetId])
    }
    // Restore also removes stale sessions; it never resurrects pre-disable state.
    await client.query('DELETE FROM app.session WHERE "userId"=$1', [targetId])
    await audit(client, identity.user.id, targetId, action)
    return { ok: true, ...(credential ?? {}) }
  })
}

export async function changePassword(headers: Headers, input: Record<string, unknown>) {
  const identity = await accountIdentity(headers, { allowPasswordChange: true })
  const currentPassword = validatePassword(input.currentPassword)
  const newPassword = validatePassword(input.newPassword)
  // Better Auth's password hash/verification applies NFKC before scrypt.
  if (currentPassword.normalize("NFKC") === newPassword.normalize("NFKC")) throw invalidInput("新密码不能与当前密码相同。")
  await consumeAccountRateLimit("change-password", identity.user.id)
  return withTransaction(async (client) => {
    const user = await recheckAccount(client, identity, { allowPasswordChange: true })
    const { rows: [account] } = await client.query<{ password: string }>('SELECT password FROM app.account WHERE "userId"=$1 AND "providerId"=$2', [user.id, "credential"])
    if (!account || !await verifyPassword({ hash: account.password, password: currentPassword })) throw new AccountError("INVALID_PASSWORD", 400, "当前密码不正确。")
    const passwordHash = await hashPassword(newPassword)
    await client.query('UPDATE app.account SET password=$1,"updatedAt"=now() WHERE "userId"=$2 AND "providerId"=$3', [passwordHash, user.id, "credential"])
    await client.query('UPDATE app."user" SET "mustChangePassword"=false,"temporaryPasswordExpiresAt"=NULL,"temporaryPasswordUsedAt"=NULL,"updatedAt"=now() WHERE id=$1', [user.id])
    await client.query('DELETE FROM app.session WHERE "userId"=$1', [user.id])
    await audit(client, user.id, user.id, "change-password")
    return { ok: true }
  })
}
