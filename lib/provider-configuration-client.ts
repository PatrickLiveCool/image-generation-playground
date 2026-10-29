import type { ProviderApiMode, ProviderModel } from "@/lib/api-provider-types"
import type { AdminProviderConfiguration, ProviderConfigurationInput, PublicModelCatalog } from "@/lib/provider-configuration-types"
import { ACCOUNT_SESSION_RECHECK_EVENT } from "@/lib/account-client"
import { ALL_ASPECT_RATIO_VALUES } from "@/components/image-combiner/model-catalog"

export class ProviderConfigurationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = "ProviderConfigurationError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function invalidResponse(): never {
  throw new ProviderConfigurationError("服务器响应未能确认，请重新载入核对后再操作。", 0, "INVALID_RESPONSE")
}

async function request(path: string, options: RequestInit = {}, timeout = 15_000): Promise<unknown> {
  const controller = new AbortController()
  const callerSignal = options.signal
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
      controller.abort()
      reject(new ProviderConfigurationError("请求超时，结果尚未确认。请重新载入核对。", 0, "REQUEST_TIMEOUT"))
    }, timeout)
  })
  try {
    return await Promise.race([cancelled, (async () => {
      if (callerSignal?.aborted) throw new DOMException("The operation was aborted.", "AbortError")
      const response = await fetch(path, {
        ...options,
        signal: controller.signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Cache-Control": "no-store", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
      })
      const value: unknown = await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return null
        throw error
      })
      if (!response.ok) {
        const detail = record(value) && record(value.error) ? value.error : null
        throw new ProviderConfigurationError(
          detail && typeof detail.message === "string" ? detail.message
            : record(value) && typeof value.error === "string" ? value.error : "操作未完成，请稍后重试。",
          response.status,
          detail && typeof detail.code === "string" ? detail.code : "REQUEST_FAILED",
        )
      }
      return value
    })()])
  } catch (error) {
    if (error instanceof ProviderConfigurationError) {
      if (typeof window !== "undefined" && (error.status === 401 || error.code === "PASSWORD_CHANGE_REQUIRED" || error.code === "FORBIDDEN")) {
        window.dispatchEvent(new Event(ACCOUNT_SESSION_RECHECK_EVENT))
      }
      throw error
    }
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new ProviderConfigurationError("网络连接中断，结果尚未确认。请重新载入核对。", 0, "NETWORK_ERROR")
  } finally {
    clearTimeout(timer)
    if (onAbort) callerSignal?.removeEventListener("abort", onAbort)
  }
}

export function providerConfigurationErrorMessage(error: unknown): string {
  return error instanceof ProviderConfigurationError ? error.message : "操作未完成，请稍后重试。"
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function readModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value) || value.length > 5000 || !value.every((model) => record(model) && typeof model.id === "string" && model.id.trim())) invalidResponse()
  return [...new Set(value.map((model) => model.id as string))].map((id) => ({ id }))
}

function readAdmin(value: unknown): AdminProviderConfiguration {
  if (!record(value) || !isRevision(value.revision) || !record(value.settings)
    || typeof value.settings.baseUrl !== "string" || value.settings.apiKey !== ""
    || !["images", "chat"].includes(value.settings.apiMode as string)
    || typeof value.secretConfigured !== "boolean" || typeof value.modelsSynced !== "boolean"
    || !Array.isArray(value.mappings) || value.mappings.length > 100
    || !value.mappings.every((mapping) => record(mapping) && typeof mapping.id === "string" && typeof mapping.name === "string" && typeof mapping.modelId === "string")) invalidResponse()
  return {
    revision: value.revision,
    settings: { baseUrl: value.settings.baseUrl, apiKey: "", apiMode: value.settings.apiMode as ProviderApiMode },
    secretConfigured: value.secretConfigured,
    models: readModels(value.models),
    mappings: value.mappings.map(({ id, name, modelId }) => ({ id, name, modelId })),
    modelsSynced: value.modelsSynced,
  }
}

export async function readAdminProviderConfiguration(signal?: AbortSignal): Promise<AdminProviderConfiguration> {
  return readAdmin(await request("/api/admin/provider", { signal }))
}

export async function saveAdminProviderConfiguration(input: ProviderConfigurationInput): Promise<AdminProviderConfiguration> {
  return readAdmin(await request("/api/admin/provider", { method: "PUT", body: JSON.stringify(input) }))
}

export async function syncProviderModels(input: { revision: number; baseUrl: string; apiKey: string; apiMode: ProviderApiMode }, signal?: AbortSignal): Promise<ProviderModel[]> {
  const value = await request("/api/provider/models", { method: "POST", body: JSON.stringify(input), signal }, 25_000)
  if (!record(value)) invalidResponse()
  return readModels(value.models)
}

export async function getPublicModelCatalog(signal?: AbortSignal): Promise<PublicModelCatalog> {
  const value = await request("/api/models", { signal })
  if (!record(value) || !isRevision(value.revision) || typeof value.configured !== "boolean"
    || !["images", "chat"].includes(value.apiMode as string) || !Array.isArray(value.mappings)
    || value.mappings.length > 100) invalidResponse()
  const ids = new Set<string>()
  const names = new Set<string>()
  const ratios = new Set<string>(ALL_ASPECT_RATIO_VALUES)
  for (const mapping of value.mappings) {
    if (!record(mapping) || typeof mapping.id !== "string" || !mapping.id.trim() || mapping.id !== mapping.id.trim() || mapping.id.length > 128
      || typeof mapping.name !== "string" || !mapping.name.trim() || mapping.name !== mapping.name.trim() || mapping.name.length > 40
      || /[\u0000-\u001f\u007f]/.test(mapping.id + mapping.name)
      || !Array.isArray(mapping.aspectRatios) || !mapping.aspectRatios.length || mapping.aspectRatios.length > ratios.size
      || !mapping.aspectRatios.every(ratio => typeof ratio === "string" && ratios.has(ratio))
      || new Set(mapping.aspectRatios).size !== mapping.aspectRatios.length) invalidResponse()
    const name = mapping.name.normalize("NFKC").toLowerCase()
    if (ids.has(mapping.id) || names.has(name)) invalidResponse()
    ids.add(mapping.id)
    names.add(name)
  }
  return { revision: value.revision, configured: value.configured, apiMode: value.apiMode as ProviderApiMode,
    mappings: value.mappings.map(({ id, name, aspectRatios }) => ({ id, name, aspectRatios: [...aspectRatios] })) }
}
