import { hashPassword, verifyPassword } from "better-auth/crypto"
import type { DatabaseInspectionClient } from "../database-target"
import { audit, insertAccount, lockAdministration } from "./account-writes"
import { AccountError } from "./errors"
import { normalizeUsername, validateName, validatePassword } from "./validation"

export type AdministratorInput = { username: unknown; name: unknown; password: unknown }
export type AdministratorTransaction = <T>(operation: (client: DatabaseInspectionClient) => Promise<T>) => Promise<T>
export function validateAdministratorInput(input: AdministratorInput) {
  return { username: normalizeUsername(input.username), name: validateName(input.name), password: validatePassword(input.password) }
}

/** 共用现有成熟哈希、固定DML与管理员锁；事务/连接由调用入口提供。 */
export async function initializeAdministrator(input: AdministratorInput, transaction: AdministratorTransaction) {
  const { username, name, password } = validateAdministratorInput(input)
  const passwordHash = await hashPassword(password)
  return transaction(async client => {
    await lockAdministration(client)
    const { rows } = await client.query('SELECT id FROM app."user" WHERE role=$1 LIMIT 1', ["admin"])
    if (rows.length) throw new AccountError("ADMIN_EXISTS", 409, "管理员已初始化，拒绝覆盖已有账号。")
    const user = await insertAccount(client, username, name, "admin", passwordHash, null)
    await audit(client, user.id, user.id, "bootstrap-admin")
    return user
  })
}

export const VERIFY_BOOTSTRAP_SQL = `WITH administrators AS (SELECT EXISTS (SELECT 1 FROM app."user" WHERE role='admin') AS initialized)
  SELECT administrators.initialized,u.id,u.username,u.name,u.role,u.banned,u."mustChangePassword",a.password,
  EXISTS (SELECT 1 FROM app.account_audit audit WHERE audit."actorId"=u.id AND audit."subjectId"=u.id AND audit.action='bootstrap-admin') AS bootstrapped
  FROM administrators LEFT JOIN app."user" u ON u.username=$1
  LEFT JOIN app.account a ON a."userId"=u.id AND a."accountId"=u.id AND a."providerId"=$2`

/** 单条只读查询核对初始凭据、可用管理员状态和初始化审计；不会补写或重置。 */
export async function verifyInitializedAdministrator(client: DatabaseInspectionClient, input: AdministratorInput): Promise<{ uninitialized: true } | { verified: true; administratorId: string }> {
  const { username, name, password } = validateAdministratorInput(input)
  // 调用方使用READ COMMITTED只读事务：等待锁之后才由下条查询取得完整快照。
  await lockAdministration(client)
  const { rows } = await client.query(VERIFY_BOOTSTRAP_SQL, [username, "credential"])
  const user = rows[0]
  if (rows.length === 1 && user.initialized === false) return { uninitialized: true }
  let matches = rows.length === 1 && user?.initialized === true && typeof user.id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(user.id) &&
    user.username === username && user.name === name && user.role === "admin" && user.banned === false && user.mustChangePassword === false &&
    user.bootstrapped === true && typeof user.password === "string"
  if (matches) {
    try { matches = await verifyPassword({ hash: user.password as string, password }) } catch { matches = false }
  }
  if (!matches) throw new AccountError("ADMIN_BOOTSTRAP_MISMATCH", 409, "无法核对同一初始化凭据、可用管理员及审计；没有执行写入。")
  return { verified: true, administratorId: user.id as string }
}
