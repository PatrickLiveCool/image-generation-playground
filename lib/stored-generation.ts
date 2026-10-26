import { createHash, randomUUID } from "node:crypto"
import type { ProviderSettings } from "./api-provider-types"
import { generateRelayImage, type ImageBytes } from "./relay-image"
import { imageExtension, type CosStore } from "./cos-assets"
import { ProviderError } from "./provider-network"

type StoredImage = { key: string; mediaType: string; bytes: number; sha256: string }
export type CreativeLineage = {
  creationId: string
  clientVersionId: string
  parentVersionId: string | null
  version: number
}

export type StoredGenerationInput = {
  model: string; prompt: string; aspectRatio: string; quality: string; images: ImageBytes[]
  hasBaseImage?: boolean
  lineage?: CreativeLineage
}

type Manifest = {
  version: 1; runId: string; status: "preparing" | "generating" | "complete" | "failed" | "cancelled"
  createdAt: string; updatedAt: string; mode: "text-to-image" | "image-editing"
  model: string; aspectRatio: string; quality: string; prompt: { text: string; length: number; sha256: string }
  inputs: StoredImage[]; output: StoredImage | null; failedStage?: string
  lineage?: CreativeLineage; baseInputKey: string | null
}

function recordImage(key: string, image: ImageBytes): StoredImage {
  return { key, mediaType: image.mediaType, bytes: image.bytes.length, sha256: createHash("sha256").update(image.bytes).digest("hex") }
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
  if (input.images.length > 2 || (input.hasBaseImage && !input.images.length) || (input.lineage?.parentVersionId && !input.hasBaseImage)) {
    throw new ProviderError("修改基准或参考图数量无效，请重新选择版本。", 400)
  }
  const runId = randomUUID()
  const prefix = `image-playground/runs/${runId}`
  const manifestKey = `${prefix}/manifest.json`
  const startedAt = Date.now()
  const manifest: Manifest = {
    version: 1, runId, status: "preparing", createdAt: new Date(startedAt).toISOString(), updatedAt: new Date(startedAt).toISOString(),
    mode: input.images.length ? "image-editing" : "text-to-image", model: input.model, aspectRatio: input.aspectRatio, quality: input.quality,
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
    for (const [index, image] of input.images.entries()) {
      signal?.throwIfAborted()
      const key = `${prefix}/inputs/reference-${index + 1}.${imageExtension(image.mediaType)}`
      await store.put(key, image.bytes, image.mediaType)
      manifest.inputs.push(recordImage(key, image))
      if (input.hasBaseImage && index === 0) manifest.baseInputKey = key
      await saveManifest()
    }
    stage = "generation"
    manifest.status = "generating"
    await saveManifest()
    signal?.throwIfAborted()
    const providerPrompt = input.hasBaseImage
      ? `以第一张图片为编辑基准，仅按本轮要求修改，保留未要求修改的内容。\n\n本轮修改要求：\n${input.prompt}`
      : input.prompt
    const result = await generate(settings, {
      model: input.model, prompt: providerPrompt, aspectRatio: input.aspectRatio,
      quality: input.quality, images: input.images,
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
