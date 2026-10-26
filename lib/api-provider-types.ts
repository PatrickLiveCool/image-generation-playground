export type ProviderApiMode = "images" | "chat"

export interface ProviderSettings {
  baseUrl: string
  apiKey: string
  apiMode: ProviderApiMode
}

export interface ModelMapping {
  id: string
  name: string
  modelId: string
}

export interface ProviderModel {
  id: string
}

export const EMPTY_PROVIDER_SETTINGS: ProviderSettings = {
  baseUrl: "",
  apiKey: "",
  apiMode: "images",
}

export function normalizeProviderSettings(settings: ProviderSettings): ProviderSettings {
  return {
    baseUrl: settings.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: settings.apiKey.trim(),
    apiMode: settings.apiMode,
  }
}

export function validateProviderSettings(settings: ProviderSettings): string | null {
  if (!settings.baseUrl.trim()) return "请填写 API Base URL。"
  try {
    const url = new URL(settings.baseUrl.trim())
    if (url.protocol !== "https:") return "Base URL 需要使用 HTTPS。"
    if (url.username || url.password || url.search || url.hash) {
      return "Base URL 只填写接口地址，请移除账号、查询参数或锚点。"
    }
  } catch {
    return "请输入完整有效的 API Base URL。"
  }
  if (!settings.apiKey.trim()) return "请填写 API Token。"
  if (/[\r\n]/.test(settings.apiKey)) return "Token 不能包含换行符。"
  if (settings.apiMode !== "images" && settings.apiMode !== "chat") {
    return "请选择图片生成接口类型。"
  }
  return null
}
