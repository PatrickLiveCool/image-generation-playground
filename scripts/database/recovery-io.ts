import { createHash } from "node:crypto"
import { fstatSync, fsyncSync, readSync, writeSync } from "node:fs"
import { authConfiguration } from "../../lib/auth/config"
import { DatabaseBoundaryError, type DatabaseConfiguration, type DatabaseInspectionClient } from "../../lib/database-target"
import { decodeProjectBackup, exportProjectBackup, MAX_PROJECT_BACKUP_BYTES, MAX_PROJECT_RECOVERY_SECRETS_BYTES, preflightProjectRestore, projectBackupStorage, projectRecoverySecrets, restoreProjectBackup, verifyRestoredProjectBackup } from "../../lib/project-backup"
import type { MaintenanceRelease } from "./maintenance"

export type RecoveryCommand = "backup" | "restore-preflight" | "restore" | "verify-restore"
export const MAX_RECOVERY_ARCHIVE_BYTES = Math.floor(MAX_PROJECT_BACKUP_BYTES * 1.4)
export const MAX_RECOVERY_SECRETS_BYTES = MAX_PROJECT_RECOVERY_SECRETS_BYTES
type Access = {
  runtime: () => Promise<void>
  migration: <T>(operation: (client: DatabaseInspectionClient) => Promise<T>) => Promise<T>
}
const ioError = () => new DatabaseBoundaryError("MAINTENANCE_IO", "受保护恢复文件描述符缺失、权限不符或读写未完成。")

export function recoveryKey(environment: NodeJS.ProcessEnv): Buffer {
  const raw = environment.IMAGE_RECOVERY_KEY
  const key = typeof raw === "string" ? Buffer.from(raw, "base64") : Buffer.alloc(0)
  if (key.length !== 32 || key.toString("base64") !== raw) throw new DatabaseBoundaryError("BACKUP_KEY_INVALID", "独立恢复密钥缺失或格式无效。")
  return key
}

/** fd由root启动器预开。没有文件名参数，且绝不把stdout/stderr当秘密输出。 */
function descriptor(fd: number, maximum: number, empty: boolean) {
  try {
    if (!Number.isInteger(fd) || fd < 3) throw ioError()
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 ||
        (stat.uid !== 0 && stat.uid !== process.getuid?.()) || stat.size > maximum || (empty ? stat.size !== 0 : stat.size < 1)) throw ioError()
    return stat
  } catch { throw ioError() }
}
export function readRecoveryInput(fd = 3): Buffer {
  return readProtectedInput(fd, MAX_RECOVERY_ARCHIVE_BYTES)
}
export function readProtectedInput(fd: number, maximum: number): Buffer {
  const initial = descriptor(fd, maximum, false)
  const buffer = Buffer.alloc(initial.size)
  try {
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (!count) throw ioError()
      offset += count
    }
    const final = descriptor(fd, maximum, false)
    if (initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size) throw ioError()
    return buffer
  } catch { throw ioError() }
}
export function prepareRecoveryOutput(fd: number, maximum: number): void {
  descriptor(fd, maximum, true)
  try { writeSync(fd, Buffer.alloc(0), 0, 0, 0) } catch { throw ioError() }
}
export function writeRecoveryOutput(fd: number, bytes: Uint8Array, maximum: number): void {
  prepareRecoveryOutput(fd, maximum)
  if (bytes.length < 1 || bytes.length > maximum) throw ioError()
  try {
    let offset = 0
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw ioError()
      offset += count
    }
    fsyncSync(fd)
  } catch { throw ioError() }
}

export async function runRecoveryMaintenance(command: RecoveryCommand, environment: NodeJS.ProcessEnv,
  release: MaintenanceRelease, configuration: DatabaseConfiguration, access: Access) {
  const key = recoveryKey(environment), storage = projectBackupStorage(environment)
  const identity = { application: "qintopia-image", command, release: { version: release.version, revision: release.revision } }
  if (command === "backup") {
    const secrets = projectRecoverySecrets(environment)
    prepareRecoveryOutput(3, MAX_RECOVERY_ARCHIVE_BYTES)
    await access.runtime()
    const bytes = await access.migration(client => exportProjectBackup(client, configuration, release as unknown as Record<string, unknown>, secrets, key, storage))
    writeRecoveryOutput(3, bytes, MAX_RECOVERY_ARCHIVE_BYTES)
    return { ...identity, archiveSha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length }
  }

  const bytes = readRecoveryInput(3)
  if (command !== "restore-preflight") prepareRecoveryOutput(4, MAX_RECOVERY_SECRETS_BYTES)
  // 完整认证先于任何数据库连接；只保留少量恢复秘密，释放大对象供后续事务使用。
  const recoveredSecrets = (() => {
    const payload = decodeProjectBackup(bytes, key)
    if (payload.storage.bucket !== storage.bucket || payload.storage.region !== storage.region || payload.storage.prefix !== storage.prefix) {
      throw new DatabaseBoundaryError("BACKUP_STORAGE_MISMATCH", "恢复归档与当前私有COS目标不匹配。")
    }
    return projectRecoverySecrets({ ...environment, ...payload.secrets })
  })()
  try { authConfiguration({ ...environment, ...recoveredSecrets, ...(configuration.target === "production" ? { NODE_ENV: "production" } : {}) }) }
  catch { throw new DatabaseBoundaryError("MAINTENANCE_SECRETS", "归档认证秘密或当前应用来源配置无效。") }
  await access.runtime()
  if (command === "restore-preflight") {
    const result = await access.migration(client => preflightProjectRestore(client, configuration, bytes, key, storage))
    return { ...identity, ready: true, contentSha256: result.contentSha256, rowCount: result.rowCount }
  }
  const result = command === "restore"
    ? await access.migration(client => restoreProjectBackup(client, configuration, bytes, key, storage))
    : await access.migration(client => verifyRestoredProjectBackup(client, configuration, bytes, key, storage))
  if (command === "verify-restore" && "notRestored" in result) {
    return { ...identity, notRestored: true, contentSha256: result.contentSha256, rowCount: 0, secretsPrepared: false }
  }
  try { writeRecoveryOutput(4, Buffer.from(JSON.stringify(recoveredSecrets) + "\n"), MAX_RECOVERY_SECRETS_BYTES) }
  catch { throw new DatabaseBoundaryError("BACKUP_SECRET_OUTPUT_UNCONFIRMED", "恢复数据已核对，但秘密恢复文件未确认写入；请仅核对恢复，不要重放数据写入。") }
  // 明确挑选安全字段；不能把库返回的secrets或归档正文扩展进stdout。
  return { ...identity, contentSha256: result.contentSha256, rowCount: result.rowCount, secretsPrepared: true,
    ...(command === "restore" ? { restored: true } : { verified: true }) }
}
