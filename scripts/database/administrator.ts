import { initializeAdministrator, validateAdministratorInput, verifyInitializedAdministrator, type AdministratorTransaction } from "../../lib/auth/bootstrap-administrator"
import { AccountError } from "../../lib/auth/errors"
import { DatabaseBoundaryError, type DatabaseInspectionClient } from "../../lib/database-target"
import type { MaintenanceRelease } from "./maintenance"
import { readProtectedInput } from "./recovery-io"

export type AdministratorCommand = "bootstrap-admin" | "verify-bootstrap-admin"
export const MAX_ADMINISTRATOR_INPUT_BYTES = 16_384

export function readAdministratorInput(fd = 3) {
  const bytes = readProtectedInput(fd, MAX_ADMINISTRATOR_INPUT_BYTES)
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "name,password,username") throw new Error("invalid shape")
    return validateAdministratorInput(value as { username: unknown; name: unknown; password: unknown })
  } catch (error) {
    if (error instanceof AccountError) throw error
    throw new AccountError("INVALID_INPUT", 400, "初始化文件须仅包含username、name和password。")
  } finally { bytes.fill(0) }
}

async function transaction<T>(client: DatabaseInspectionClient, readonly: boolean, operation: () => Promise<T>): Promise<T> {
  await client.query(readonly ? "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY" : "BEGIN")
  let committing = false
  try {
    const result = await operation()
    committing = true
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    if (committing && !readonly) throw new DatabaseBoundaryError("ADMIN_BOOTSTRAP_UNCONFIRMED", "管理员初始化提交未确认；请只读核对同一凭据，禁止自动重放。")
    throw error
  }
}

export async function runAdministratorMaintenance(command: AdministratorCommand, release: MaintenanceRelease,
  access: <T>(operation: (client: DatabaseInspectionClient) => Promise<T>) => Promise<T>) {
  const input = readAdministratorInput(3)
  const identity = { application: "qintopia-image", command, release: { version: release.version, revision: release.revision } }
  if (command === "bootstrap-admin") {
    const run: AdministratorTransaction = operation => access(client => transaction(client, false, () => operation(client)))
    const administratorId = (await initializeAdministrator(input, run)).id
    return { ...identity, administratorId, initialized: true }
  }
  const result = await access(client => transaction(client, true, () => verifyInitializedAdministrator(client, input)))
  return "uninitialized" in result ? { ...identity, uninitialized: true } : { ...identity, administratorId: result.administratorId, verified: true }
}
