import { randomUUID } from "node:crypto"
import type { AdminAccountUser } from "../account-types"
import type { DatabaseInspectionClient } from "../database-target"

// 初始化、后台开户和最后管理员保护共用同一事务锁。
const ADMIN_LOCK = 1_909_961_701
export async function lockAdministration(client: DatabaseInspectionClient) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK])
}
export async function audit(client: DatabaseInspectionClient, actor: string, subject: string, action: string) {
  await client.query('INSERT INTO app.account_audit ("actorId","subjectId",action) VALUES ($1,$2,$3)', [actor, subject, action])
}
export async function insertAccount(client: DatabaseInspectionClient, username: string, name: string, role: "admin" | "user", passwordHash: string, expiresAt: Date | null): Promise<AdminAccountUser> {
  const id = randomUUID()
  const { rows: [user] } = await client.query(
    'INSERT INTO app."user" (id,name,email,"emailVerified",username,"displayUsername",role,"mustChangePassword","temporaryPasswordExpiresAt") VALUES ($1,$2,$3,true,$4,$4,$5,$6,$7) RETURNING id,username,name,role,banned,"mustChangePassword","createdAt"',
    [id, name, `${id}@accounts.invalid`, username, role, Boolean(expiresAt), expiresAt],
  )
  await client.query('INSERT INTO app.account (id,"accountId","providerId","userId",password) VALUES ($1,$2,$3,$2,$4)', [randomUUID(), id, "credential", passwordHash])
  return user as unknown as AdminAccountUser
}
