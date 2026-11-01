import type { ModelMapping, ProviderApiMode, ProviderModel, ProviderSettings } from "./api-provider-types"
import type { ProviderConfigurationInput } from "./provider-configuration-types"
import { invalidInput } from "./auth/errors"
import { normalizeModelMappings, validateModelMappings } from "./model-mappings"
import { normalizeBaseUrl, ProviderError } from "./provider-network"

export const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024
type DraftConnection = { revision: number; baseUrl: string; apiKey: string; apiMode: ProviderApiMode }

// 纯输入验证可供维护包复用，不导入认证服务、数据库会话或后台动作。
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw invalidInput("模型配置格式不正确。")
  return value as Record<string, unknown>
}

function boundedInput(value: unknown) {
  try {
    const serialized = JSON.stringify(value)
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_PROVIDER_JSON_BYTES) throw invalidInput()
  } catch { throw invalidInput("模型配置超过 2 MiB 或格式不正确。") }
}

export function validateProviderRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= 2_147_483_647) throw invalidInput("配置版本无效，请刷新后重试。")
  return value as number
}

function connection(value: unknown): ProviderSettings {
  const input = object(value, ["baseUrl", "apiKey", "apiMode"])
  let baseUrl: string
  try { baseUrl = normalizeBaseUrl(input.baseUrl) } catch (error) {
    throw invalidInput(error instanceof ProviderError ? error.message : "请输入有效的公网 HTTPS 地址。")
  }
  if (typeof input.apiKey !== "string" || input.apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.apiKey)) throw invalidInput("请输入有效的 API Token。")
  const apiKey = input.apiKey.trim()
  // 旧秘密只可用于管理员提交的原样地址。不能先规范化地址，再把
  // 被编辑过的路径、大小写或末尾斜杠当作“未更换地址”。
  if (!apiKey && input.baseUrl !== baseUrl) throw invalidInput("更换 Base URL 后请重新输入 Token。")
  if (apiKey && /^[*•●·…xX\s]+$/.test(apiKey)) throw invalidInput("掩码不能作为 Token，请输入新的 Token 或留空保留。")
  if (input.apiMode !== "images" && input.apiMode !== "chat") throw invalidInput("请选择支持的 API 接口格式。")
  return { baseUrl, apiKey, apiMode: input.apiMode }
}

export function validateProviderConfiguration(value: unknown): ProviderConfigurationInput {
  boundedInput(value)
  const input = object(value, ["revision", "settings", "models", "mappings", "modelsSynced"])
  const settings = connection(input.settings)
  if (!Array.isArray(input.models) || input.models.length > 5000 || !Array.isArray(input.mappings) || input.mappings.length > 100 || typeof input.modelsSynced !== "boolean") throw invalidInput("最多保存 5000 个候选模型和 100 条名称映射。")
  const models = input.models.map((item): ProviderModel => {
    const model = object(item, ["id"])
    if (typeof model.id !== "string" || !model.id.trim() || model.id.length > 256 || /[\u0000-\u001f\u007f]/.test(model.id)) throw invalidInput("候选模型 ID 无效。")
    return { id: model.id.trim() }
  })
  if (new Set(models.map(model => model.id)).size !== models.length) throw invalidInput("候选模型 ID 重复。")
  const mappings = normalizeModelMappings(input.mappings.map((item): ModelMapping => {
    const mapping = object(item, ["id", "name", "modelId"])
    if (typeof mapping.id !== "string" || !mapping.id.trim() || mapping.id !== mapping.id.trim() || mapping.id.length > 128 || /[\u0000-\u001f\u007f]/.test(mapping.id) || typeof mapping.name !== "string" || typeof mapping.modelId !== "string" || /[\u0000-\u001f\u007f]/.test(mapping.name + mapping.modelId)) throw invalidInput("名称映射格式不正确。")
    return { id: mapping.id, name: mapping.name, modelId: mapping.modelId }
  }))
  const mappingError = validateModelMappings(mappings)
  if (mappingError) throw invalidInput(mappingError)
  return { revision: validateProviderRevision(input.revision), settings, models, mappings, modelsSynced: input.modelsSynced }
}

export function validateProviderDraft(value: unknown): DraftConnection {
  boundedInput(value)
  const input = object(value, ["revision", "baseUrl", "apiKey", "apiMode"])
  return { revision: validateProviderRevision(input.revision), ...connection({ baseUrl: input.baseUrl, apiKey: input.apiKey, apiMode: input.apiMode }) }
}
