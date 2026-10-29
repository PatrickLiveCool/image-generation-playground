import { ACCOUNT_SESSION_RECHECK_EVENT } from "./account-client"
import type { PrivateCreation, PrivateRun } from "./private-workspace-types"

export class PrivateWorkspaceError extends Error {
  constructor(message: string, readonly status = 0, readonly code = "UNCONFIRMED") { super(message) }
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object") }
function validRun(value: unknown): value is PrivateRun {
  return record(value) && typeof value.id === "string" && typeof value.creationId === "string"
    && Number.isSafeInteger(value.creationRevision) && Number(value.creationRevision) >= 1
    && Number.isSafeInteger(value.version) && (value.parentVersionId === null || typeof value.parentVersionId === "string")
    && ["preparing", "generating", "saving", "complete", "failed", "unknown", "save_pending"].includes(String(value.status))
    && (value.imageUrl === null || (typeof value.imageUrl === "string" && /^\/api\/images\/[0-9a-f-]{36}$/i.test(value.imageUrl)))
    && (value.status !== "complete" || Boolean(value.imageUrl))
    && ["prompt", "mappingId", "modelLabel", "aspectRatio", "quality"].every(key => typeof value[key] === "string")
    && ["text-to-image", "image-editing"].includes(String(value.mode))
    && typeof value.createdAt === "number" && typeof value.updatedAt === "number"
}
function validCreation(value: unknown): value is PrivateCreation {
  return record(value) && typeof value.id === "string" && typeof value.title === "string" && Number.isSafeInteger(value.revision)
    && typeof value.createdAt === "number" && typeof value.updatedAt === "number" && Array.isArray(value.versions)
    && value.versions.every(run => validRun(run) && run.creationId === value.id)
}
function invalid(): never { throw new PrivateWorkspaceError("服务器结果尚未确认，请刷新创作或查看任务状态。") }

export async function privateRequest(path: string, options: RequestInit = {}, timeout = 15_000): Promise<unknown> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(abort, timeout)
  try {
    const response = await fetch(path, { ...options, cache: "no-store", credentials: "same-origin", signal: controller.signal })
    const value: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const error = record(value) && record(value.error) ? value.error : null
      const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED"
      if (response.status === 401 || (code === "PASSWORD_CHANGE_REQUIRED" || code === "FORBIDDEN")) window.dispatchEvent(new Event(ACCOUNT_SESSION_RECHECK_EVENT))
      throw new PrivateWorkspaceError(typeof error?.message === "string" ? error.message : "操作未完成，请刷新后核对。", response.status, code)
    }
    if (controller.signal.aborted) invalid()
    return value
  } catch (error) {
    if (error instanceof PrivateWorkspaceError) throw error
    throw new PrivateWorkspaceError("连接中断，操作结果尚未确认。请刷新创作或查看任务状态，请勿重复提交。")
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", abort)
  }
}

export async function listPrivateWorkspace(signal?: AbortSignal): Promise<PrivateCreation[]> {
  const value = await privateRequest("/api/creations", { signal })
  if (!record(value) || !Array.isArray(value.creations) || !value.creations.every(validCreation)) invalid()
  return value.creations
}
export async function createRemoteCreation(id: string, title: string, signal?: AbortSignal): Promise<PrivateCreation> {
  const value = await privateRequest("/api/creations", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, title }) })
  if (!record(value) || !validCreation(value.creation) || value.creation.id !== id) invalid()
  return value.creation
}
export async function renameRemoteCreation(id: string, revision: number, title: string, signal?: AbortSignal): Promise<PrivateCreation> {
  const value = await privateRequest(`/api/creations/${encodeURIComponent(id)}`, { method: "PATCH", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision, title }) })
  if (!record(value) || !validCreation(value.creation) || value.creation.id !== id) invalid()
  return value.creation
}
export async function requestPrivateRun(id: string, options: { signal?: AbortSignal; repair?: boolean; formData?: FormData } = {}): Promise<PrivateRun> {
  const value = await privateRequest(options.formData ? "/api/generate-image" : `/api/runs/${encodeURIComponent(id)}${options.repair ? "/repair" : ""}`, {
    signal: options.signal, ...(options.formData || options.repair ? { method: "POST" } : {}), ...(options.formData ? { body: options.formData } : {}),
  }, options.formData ? 10 * 60_000 : options.repair ? 125_000 : 15_000)
  if (!record(value) || !validRun(value.run) || value.run.id !== id) invalid()
  return value.run
}
