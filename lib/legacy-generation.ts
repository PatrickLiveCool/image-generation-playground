// 已撤下的匿名请求解析仅保留为下一阶段迁移的回归参考；没有公开路由调用此函数。
import { ProviderError, validateProviderSettings } from "./provider-network"
import { imageBytes, readImageSource, type ImageBytes } from "./relay-image"
import { createCosStore, readOwnedAsset } from "./cos-assets"
import { generateAndStore, type CreativeLineage } from "./stored-generation"
import { parseDocument } from "./document-parser"


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024

type Reference = { file: File } | { url: string }

function referenceFrom(form: FormData, key: string): Reference | undefined {
  const file = form.get(key)
  const source = form.get(`${key}Url`)
  if (file !== null && !(file instanceof File)) throw new ProviderError("参考图片格式无效。", 400)
  if (source !== null && typeof source !== "string") throw new ProviderError("参考图片链接格式无效。", 400)
  if (file instanceof File && file.size) {
    if (file.size > MAX_REFERENCE_BYTES) throw new ProviderError("单张参考图不能超过 10 MB。", 400)
    return { file }
  }
  if (typeof source === "string" && source.trim()) return { url: source.trim() }
  return undefined
}

function creativeContext(form: FormData): { lineage?: CreativeLineage; baseImageUrl?: string } {
  const rawBase = form.get("baseImageUrl")
  if (form.has("baseImageUrl") && (typeof rawBase !== "string" || !rawBase.trim())) {
    throw new ProviderError("修改基准图片缺失，请重新选择要修改的版本。", 400)
  }
  const baseImageUrl = typeof rawBase === "string" ? rawBase.trim() : undefined
  const fields = ["creationId", "clientVersionId", "parentVersionId", "version"]
  // Existing clients may continue sending standalone image requests.
  if (!fields.some(field => form.has(field))) return { baseImageUrl }

  const creationId = form.get("creationId")
  const clientVersionId = form.get("clientVersionId")
  const rawParent = form.get("parentVersionId")
  const rawVersion = form.get("version")
  if (typeof creationId !== "string" || !UUID.test(creationId) || typeof clientVersionId !== "string" || !UUID.test(clientVersionId)) {
    throw new ProviderError("创作或版本标识无效，请刷新后重试。", 400)
  }
  if (typeof rawVersion !== "string" || !/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))) {
    throw new ProviderError("版本编号无效。", 400)
  }
  if (rawParent !== null && typeof rawParent !== "string") throw new ProviderError("基准版本标识无效。", 400)
  const parentVersionId = typeof rawParent === "string" && rawParent !== "" ? rawParent : null
  if (parentVersionId && (!VERSION_ID.test(parentVersionId) || parentVersionId === clientVersionId)) {
    throw new ProviderError("基准版本标识无效。", 400)
  }
  if (Boolean(parentVersionId) !== Boolean(baseImageUrl)) {
    throw new ProviderError("基准版本与图片不一致，请重新选择要修改的版本。", 400)
  }
  return { baseImageUrl, lineage: { creationId, clientVersionId, parentVersionId, version: Number(rawVersion) } }
}

export async function generateLegacyRequest(request: Request) {
  try {
    const form = await request.formData()
    const settings = validateProviderSettings({ baseUrl: form.get("baseUrl"), apiKey: form.get("apiKey"), apiMode: form.get("apiMode") })
    const prompt = form.get("prompt")
    const model = form.get("selectedModel")
    const aspectRatio = String(form.get("aspectRatio") || "square")
    const quality = String(form.get("quality") || "auto")
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 5000) throw new ProviderError("请输入提示词，最多 5000 字。", 400)
    if (typeof model !== "string" || !model.trim() || model.length > 256 || /[\r\n]/.test(model)) throw new ProviderError("请选择模型或填写有效的模型 ID。", 400)
    if (!["auto", "low", "medium", "high"].includes(quality)) throw new ProviderError("画质参数无效。", 400)
    if (!["square", "portrait", "landscape", "wide", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5"].includes(aspectRatio)) throw new ProviderError("宽高比参数无效。", 400)
    const context = creativeContext(form)
    const rawDocument = form.get("document")
    if (rawDocument !== null && !(rawDocument instanceof File)) throw new ProviderError("文档格式无效。", 400)
    const document = rawDocument instanceof File ? await parseDocument(rawDocument) : undefined
    const reference1 = referenceFrom(form, "image1")
    const reference2 = referenceFrom(form, "image2")
    if (context.baseImageUrl && reference2) {
      throw new ProviderError("继续修改时最多添加一张补充参考图，请使用第一张参考图位置。", 400)
    }
    const references = [reference1, reference2].filter((reference): reference is Reference => Boolean(reference))
    if (!context.baseImageUrl && !references.length && !document?.images.length && form.get("mode") === "image-editing") {
      throw new ProviderError("编辑模式下至少需要一张参考图。", 400)
    }
    const store = createCosStore()
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(240_000)])
    const images: ImageBytes[] = []
    const loadSource = async (source: string) => {
      const owned = await readOwnedAsset(source, store)
      return owned ?? await readImageSource(source, signal)
    }
    // The chosen version always occupies the first input position. A bad base
    // must fail the edit, never silently turn it into a fresh generation.
    if (context.baseImageUrl) images.push(await loadSource(context.baseImageUrl))
    for (const reference of references) {
      const image = "file" in reference
        ? imageBytes(new Uint8Array(await reference.file.arrayBuffer()))
        : await loadSource(reference.url)
      if (image.bytes.length > MAX_REFERENCE_BYTES) throw new ProviderError("单张参考图不能超过 10 MB。", 400)
      images.push(image)
    }
    const result = await generateAndStore(settings, {
      model: model.trim(), prompt, aspectRatio, quality, images,
      document,
      hasBaseImage: Boolean(context.baseImageUrl), lineage: context.lineage,
    }, store, signal)
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    // Never log or return upstream response bodies, request headers or credentials.
    const message = error instanceof ProviderError ? error.message : "生成未完成，请检查中转连接或稍后重试。"
    return Response.json({ error: message }, { status: error instanceof ProviderError ? error.status : 502 })
  }
}
