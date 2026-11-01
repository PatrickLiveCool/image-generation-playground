import type { Generation } from "@/components/image-combiner/types"
import type { Creation } from "./creation-types"
import type { PublicModelCatalog } from "./provider-configuration-types"
import { resolveModelMapping } from "./model-mappings"
import { composePrompt, MAX_DOCUMENT_CHARS, validateDocumentFile } from "./document-context"
import { composeAnnotatedPrompt, serializeAnnotationSnapshot, validateAnnotationSnapshot } from "./image-annotations"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const ASPECT_RATIOS = new Set(["square", "portrait", "landscape", "wide", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5"])

export interface BuildCreationRequestInput {
  creation: Creation
  catalog: PublicModelCatalog
  generationId?: string
  now?: number
}

function validateImageSource(source: string): void {
  // Private references are resolved with the same account ownership checks.
  if (/^\/api\/images\/[0-9a-f-]{36}$/.test(source) || /^data:image\/(?:png|jpe?g|webp|gif);base64,/.test(source)) return
  try {
    const url = new URL(source)
    if (url.protocol === "https:" && !url.username && !url.password && !url.hash) return
  } catch { /* Report the same actionable message for malformed links. */ }
  throw new Error("参考图片需要使用有效的 HTTPS 链接，或重新选择已保存的图片。")
}

/** Capture one creation's current inputs before any asynchronous work starts. */
export function buildCreationRequest({ creation, catalog, generationId = crypto.randomUUID(), now = Date.now() }: BuildCreationRequestInput): { formData: FormData; generation: Generation } {
  const { draft } = creation
  if (!UUID.test(creation.id) || !UUID.test(generationId)) throw new Error("创作或版本标识无效，请刷新后重试。")
  if (creation.versions.some(version => version.status === "loading")) throw new Error("当前创作正在生成，请等待完成后再修改。")
  if (creation.versions.some(version => version.id === generationId)) throw new Error("版本标识重复，请重新提交。")
  const documentName = draft.documentName ?? ""
  const documentText = draft.documentText ?? ""
  const annotationDraft = creation.selectedVersionId ? draft.annotationDrafts?.[creation.selectedVersionId] : undefined
  const annotationSnapshot = annotationDraft?.snapshot.marks.length ? validateAnnotationSnapshot(annotationDraft.snapshot) : null
  const effectivePrompt = composePrompt(annotationSnapshot ? composeAnnotatedPrompt(draft.prompt, annotationSnapshot) : draft.prompt, documentName, documentText)
  if ((!draft.prompt.trim() && !annotationSnapshot) || effectivePrompt.length > 5000) throw new Error(documentText.trim() || annotationSnapshot ? "提示词、批注和文档上下文合计不能超过 5000 字，请精简内容。" : "请输入提示词，最多 5000 字。")
  if (documentText.length > MAX_DOCUMENT_CHARS) throw new Error(`文档文字不能超过 ${MAX_DOCUMENT_CHARS} 个字符，请重新上传精简后的文档。`)
  if (draft.documentFile) validateDocumentFile(draft.documentFile)

  if (!catalog.configured) throw new Error("暂无可用模型，请联系管理员完成配置。")
  const mapping = resolveModelMapping(catalog.mappings, draft.selectedMappingId)
  if (!mapping) throw new Error("所选模型已被移除或不可用，请刷新目录并重新选择。")
  if (!mapping.id || !mapping.name.trim()) throw new Error("模型目录无效，请刷新后重试。")
  if (!ASPECT_RATIOS.has(draft.aspectRatio)) throw new Error("宽高比参数无效。")
  if (!mapping.aspectRatios.includes(draft.aspectRatio)) throw new Error("当前模型不支持所选宽高比，请重新选择。")
  if (!["auto", "low", "medium", "high"].includes(draft.quality)) throw new Error("画质参数无效。")
  if (typeof draft.useUrls !== "boolean") throw new Error("请选择参考图片的输入方式。")

  const base = creation.selectedVersionId === null ? undefined : creation.versions.find(version => version.id === creation.selectedVersionId)
  if (creation.selectedVersionId !== null && (!base || base.status !== "complete" || !base.imageUrl?.trim())) {
    throw new Error("所选基准版本没有可用图片，请重新选择要修改的版本。")
  }
  if (base?.imageUrl) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(base.id)) throw new Error("基准版本标识无效，请重新选择要修改的版本。")
  }

  const files = [draft.image1, draft.image2].filter((file): file is File => file !== null)
  const urls = [draft.image1Url, draft.image2Url].map(url => url.trim()).filter(Boolean)
  if ((draft.useUrls && files.length) || (!draft.useUrls && urls.length)) {
    throw new Error("文件与链接中都有参考图，请先清空另一种输入方式中的参考图后提交。")
  }
  const references = draft.useUrls ? urls : files
  if (annotationSnapshot) {
    if (!base || annotationSnapshot.baseVersionId !== base.id || base.imageUrl !== `/api/images/${annotationSnapshot.image.assetId}`) throw new Error("批注基准与当前图片不匹配，请重新选择基础版本。")
    if (!mapping.annotation?.available || mapping.annotation.expression !== "overlay-v1") throw new Error(mapping.annotation?.reason || "当前模型尚未确认支持区域批注，请更换模型或联系管理员记录能力。")
    if (references.length) throw new Error("区域批注已使用原图与标注图两个输入，请移除补充参考图后提交。")
    if ((draft.documentFile || documentText.trim()) && draft.documentImageInspection !== "none") throw new Error("区域批注仅支持已确认无图片的文档，请改用纯 TXT 或移除文档。")
  }
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
    mappingId: mapping.id, configRevision: String(catalog.revision), prompt: draft.prompt, aspectRatio: draft.aspectRatio, quality: draft.quality,
    mode, creationId: creation.id, clientRequestId: generationId,
  })) formData.set(key, value)
  if (base?.imageUrl) {
    formData.set("parentVersionId", base.id)
  }
  if (annotationSnapshot) formData.set("annotationSnapshot", serializeAnnotationSnapshot(annotationSnapshot))
  references.forEach((reference, index) => {
    if (typeof reference === "string") formData.set(`image${index + 1}Url`, reference)
    else formData.set(`image${index + 1}`, reference)
  })
  if (draft.documentFile) formData.set("document", draft.documentFile, draft.documentFile.name)
  else if (documentText.trim()) {
    formData.set("documentName", documentName || "恢复文档.txt")
    formData.set("documentText", documentText)
  }

  // Only a stable mapping ID is submitted. The server resolves its configuration and original base asset.
  const generation: Generation = {
    id: generationId, creationId: creation.id, version, parentVersionId: base?.id ?? null,
    runStatus: "preparing", submittedDraftRevision: creation.draftRevision, quality: draft.quality,
    annotationSnapshot, ...(annotationSnapshot ? { submittedAnnotationRevision: annotationDraft!.revision } : {}),
    model: mapping.id, modelLabel: mapping.name, status: "loading", progress: 0, phase: "sending",
    imageUrl: null, prompt: draft.prompt, timestamp: now, aspectRatio: draft.aspectRatio, mode,
  }
  return { formData, generation }
}
