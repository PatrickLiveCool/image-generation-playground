import type { Generation } from "@/components/image-combiner/types"
import type { Creation } from "./creation-types"
import { normalizeProviderSettings, validateProviderSettings, type ModelMapping, type ProviderSettings } from "./api-provider-types"
import { normalizeModelMappings, resolveModelMapping, validateModelMappings } from "./model-mappings"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const ASPECT_RATIOS = new Set(["square", "portrait", "landscape", "wide", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5"])

export interface BuildCreationRequestInput {
  creation: Creation
  settings: ProviderSettings
  mappings: ModelMapping[]
  generationId?: string
  now?: number
}

function validateImageSource(source: string): void {
  // Relative asset capabilities and older inline images are resolved by the server.
  if (source.startsWith("/api/assets/") || /^data:image\/(?:png|jpe?g|webp|gif);base64,/.test(source)) return
  try {
    const url = new URL(source)
    if (url.protocol === "https:" && !url.username && !url.password && !url.hash) return
  } catch { /* Report the same actionable message for malformed links. */ }
  throw new Error("参考图片需要使用有效的 HTTPS 链接，或重新选择已保存的图片。")
}

/** Capture one creation's current inputs before any asynchronous work starts. */
export function buildCreationRequest({ creation, settings, mappings, generationId = crypto.randomUUID(), now = Date.now() }: BuildCreationRequestInput): { formData: FormData; generation: Generation } {
  const { draft } = creation
  if (!UUID.test(creation.id) || !UUID.test(generationId)) throw new Error("创作或版本标识无效，请刷新后重试。")
  if (creation.versions.some(version => version.status === "loading")) throw new Error("当前创作正在生成，请等待完成后再修改。")
  if (creation.versions.some(version => version.id === generationId)) throw new Error("版本标识重复，请重新提交。")
  if (!draft.prompt.trim() || draft.prompt.length > 5000) throw new Error("请输入提示词，最多 5000 字。")

  const providerError = validateProviderSettings(settings)
  if (providerError) throw new Error(providerError)
  if (settings.baseUrl.length > 2048 || settings.apiKey.length > 4096) throw new Error("API 地址或 Token 长度无效，请检查 API 设置。")
  const provider = normalizeProviderSettings(settings)
  const selectedMapping = resolveModelMapping(mappings, draft.selectedMappingId)
  if (!selectedMapping) throw new Error("请选择有效的模型映射，或到 API 设置中添加。")
  const mappingError = validateModelMappings([selectedMapping])
  if (mappingError) throw new Error(mappingError)
  const [mapping] = normalizeModelMappings([selectedMapping])
  if (!ASPECT_RATIOS.has(draft.aspectRatio)) throw new Error("宽高比参数无效。")
  if (!["auto", "low", "medium", "high"].includes(draft.quality)) throw new Error("画质参数无效。")
  if (typeof draft.useUrls !== "boolean") throw new Error("请选择参考图片的输入方式。")

  const base = creation.selectedVersionId === null ? undefined : creation.versions.find(version => version.id === creation.selectedVersionId)
  if (creation.selectedVersionId !== null && (!base || base.status !== "complete" || !base.imageUrl?.trim())) {
    throw new Error("所选基准版本没有可用图片，请重新选择要修改的版本。")
  }
  if (base?.imageUrl) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(base.id)) throw new Error("基准版本标识无效，请重新选择要修改的版本。")
    validateImageSource(base.imageUrl)
  }

  const files = [draft.image1, draft.image2].filter((file): file is File => file !== null)
  const urls = [draft.image1Url, draft.image2Url].map(url => url.trim()).filter(Boolean)
  if ((draft.useUrls && files.length) || (!draft.useUrls && urls.length)) {
    throw new Error("文件与链接中都有参考图，请先清空另一种输入方式中的参考图后提交。")
  }
  const references = draft.useUrls ? urls : files
  if (base && references.length > 1) throw new Error("继续修改时最多添加一张补充参考图，请移除多余参考图。")
  for (const file of files) {
    if (!(file instanceof File) || !file.size || file.size > MAX_REFERENCE_BYTES) throw new Error("参考图片不能为空，且单张不能超过 10 MB。")
  }
  for (const url of urls) validateImageSource(url)

  const maxVersion = Math.max(0, ...creation.versions.filter(version => version.status === "complete").map(version => version.version ?? 0))
  const version = maxVersion + 1
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("版本编号无效，请重新打开创作后重试。")
  const mode = base || references.length ? "image-editing" : "text-to-image"
  const formData = new FormData()
  for (const [key, value] of Object.entries({
    baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiMode: provider.apiMode,
    selectedModel: mapping.modelId, prompt: draft.prompt, aspectRatio: draft.aspectRatio, quality: draft.quality,
    mode, creationId: creation.id, clientVersionId: generationId, version: String(version),
  })) formData.set(key, value)
  if (base?.imageUrl) {
    formData.set("baseImageUrl", base.imageUrl)
    formData.set("parentVersionId", base.id)
  }
  references.forEach((reference, index) => {
    if (typeof reference === "string") formData.set(`image${index + 1}Url`, reference)
    else formData.set(`image${index + 1}`, reference)
  })

  // Credentials and reference capabilities belong only in the request, never in history metadata.
  const generation: Generation = {
    id: generationId, creationId: creation.id, version, parentVersionId: base?.id ?? null,
    model: mapping.modelId, modelLabel: mapping.name, status: "loading", progress: 0, phase: "sending",
    imageUrl: null, prompt: draft.prompt, timestamp: now, aspectRatio: draft.aspectRatio, mode,
  }
  return { formData, generation }
}
