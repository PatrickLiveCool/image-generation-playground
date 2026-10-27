import { createHash, randomUUID } from "node:crypto"
import type { ProviderSettings } from "./api-provider-types"
import { generateRelayImage, type ImageBytes } from "./relay-image"
import { imageExtension, type CosStore } from "./cos-assets"
import { ProviderError } from "./provider-network"
import { composePrompt, documentExtension } from "./document-context"

type StoredImage = { key: string; mediaType: string; bytes: number; sha256: string }
type StoredDocumentRecord = { key: string; name: string; mediaType: string; bytes: number; sha256: string; textLength: number; imageCount: number }
export type CreativeLineage = {
  creationId: string
  clientVersionId: string
  parentVersionId: string | null
  version: number
}

export type StoredGenerationInput = {
  model: string; prompt: string; aspectRatio: string; quality: string; images: ImageBytes[]
  document?: { name: string; mediaType: string; bytes: Uint8Array; text: string; images: ImageBytes[] }
  hasBaseImage?: boolean
  lineage?: CreativeLineage
}

type Manifest = {
  version: 1; runId: string; status: "preparing" | "generating" | "complete" | "failed" | "cancelled"
  createdAt: string; updatedAt: string; mode: "text-to-image" | "image-editing"
  model: string; aspectRatio: string; quality: string; prompt: { text: string; length: number; sha256: string }
  inputs: StoredImage[]; document?: StoredDocumentRecord; output: StoredImage | null; failedStage?: string
  lineage?: CreativeLineage; baseInputKey: string | null
}

function recordImage(key: string, image: ImageBytes): StoredImage {
  return { key, mediaType: image.mediaType, bytes: image.bytes.length, sha256: createHash("sha256").update(image.bytes).digest("hex") }
}

function recordDocument(key: string, document: NonNullable<StoredGenerationInput["document"]>): StoredDocumentRecord {
  return { key, name: document.name, mediaType: document.mediaType, bytes: document.bytes.length, sha256: createHash("sha256").update(document.bytes).digest("hex"), textLength: document.text.length, imageCount: document.images.length }
}

/** This orchestration never writes files or falls back to another storage service.
 * Storage retries (if any) use the same object key; a model request is never repeated. */
export async function generateAndStore(
  settings: ProviderSettings,
  input: StoredGenerationInput,
  store: CosStore,
  signal?: AbortSignal,
  generate: typeof generateRelayImage = generateRelayImage,
) {
  const documentImages = input.document?.images ?? []
  if (input.images.length + documentImages.length > 2 || (input.hasBaseImage && !input.images.length) || (input.lineage?.parentVersionId && !input.hasBaseImage)) {
    throw new ProviderError("修改基准或参考图数量无效，请重新选择版本。", 400)
  }
  const runId = randomUUID()
  const prefix = `image-playground/runs/${runId}`
  const manifestKey = `${prefix}/manifest.json`
  const startedAt = Date.now()
  const manifest: Manifest = {
    version: 1, runId, status: "preparing", createdAt: new Date(startedAt).toISOString(), updatedAt: new Date(startedAt).toISOString(),
    mode: input.images.length + documentImages.length ? "image-editing" : "text-to-image", model: input.model, aspectRatio: input.aspectRatio, quality: input.quality,
    prompt: { text: input.prompt, length: input.prompt.length, sha256: createHash("sha256").update(input.prompt).digest("hex") },
    inputs: [], output: null, baseInputKey: null,
    ...(input.lineage ? { lineage: { ...input.lineage } } : {}),
  }
  const saveManifest = async () => {
    manifest.updatedAt = new Date().toISOString()
    await store.put(manifestKey, Buffer.from(JSON.stringify(manifest)), "application/json")
  }
  let stage = "preflight"
  // A real authenticated COS write must succeed before any billable upstream call.
  await saveManifest()
  try {
    signal?.throwIfAborted()
    stage = "inputs"
    if (input.document) {
      const documentKey = `${prefix}/inputs/document.${documentExtension(input.document.name)}`
      await store.put(documentKey, input.document.bytes, input.document.mediaType)
      manifest.document = recordDocument(documentKey, input.document)
      await saveManifest()
    }
    const allImages = [...input.images, ...documentImages]
    for (const [index, image] of allImages.entries()) {
      signal?.throwIfAborted()
      const documentImage = index >= input.images.length
      const imageNumber = documentImage ? index - input.images.length + 1 : index + 1
      const key = `${prefix}/inputs/${documentImage ? `document-image-${imageNumber}` : `reference-${imageNumber}`}.${imageExtension(image.mediaType)}`
      await store.put(key, image.bytes, image.mediaType)
      manifest.inputs.push(recordImage(key, image))
      if (input.hasBaseImage && index === 0) manifest.baseInputKey = key
      await saveManifest()
    }
    stage = "generation"
    manifest.status = "generating"
    await saveManifest()
    signal?.throwIfAborted()
    const promptWithDocument = input.document ? composePrompt(input.prompt, input.document.name, input.document.text) : input.prompt
    if (promptWithDocument.length > 5000) throw new ProviderError("提示词和文档上下文合计不能超过 5000 字，请精简后重试。", 400)
    const providerPrompt = input.hasBaseImage
      ? `以第一张图片为编辑基准，仅按本轮要求修改，保留未要求修改的内容。\n\n本轮修改要求：\n${promptWithDocument}`
      : promptWithDocument
    const result = await generate(settings, {
      model: input.model, prompt: providerPrompt, aspectRatio: input.aspectRatio,
      quality: input.quality, images: allImages,
    }, signal)
    stage = "output"
    const key = `${prefix}/outputs/final.${imageExtension(result.mediaType)}`
    await store.put(key, result.bytes, result.mediaType)
    manifest.output = recordImage(key, result)
    stage = "finalize"
    manifest.status = "complete"
    await saveManifest()
    return { url: store.assetUrl(key), prompt: input.prompt, description: "", durationMs: Date.now() - startedAt, runId, ...(input.lineage ?? {}) }
  } catch (error) {
    manifest.status = signal?.aborted ? "cancelled" : "failed"
    manifest.failedStage = stage
    // Failure metadata is best-effort and contains no upstream error body or credentials.
    try { await saveManifest() } catch {}
    throw error
  }
}
