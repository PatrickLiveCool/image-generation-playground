import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { serializeAnnotationSnapshot, validateAnnotationSnapshot, orientedImageSize, composeAnnotatedPrompt } from "./image-annotations"
import { renderAnnotationOverlay } from "./annotation-renderer"
import { validateAnnotationExecution, type AnnotationExecution } from "./annotation-execution"
import { validateResolvedAnnotationCapability } from "./annotation-capability"
import { composePrompt, MAX_DOCUMENT_BYTES } from "./document-context"
import { parseDocument } from "./document-parser"
import { AccountError } from "./auth/errors"
import { recheckAccount, type AccountIdentity } from "./auth/guards"
import { withTransaction } from "./database"
import { createPrivateCosStore, MAX_PRIVATE_MANIFEST_BYTES, type PrivateCosStore } from "./private-cos"
import { bytesHash, assertPrivateReferenceSource, MAX_REFERENCE_BYTES, type ParsedPrivateGeneration } from "./private-generation-input"
import { generateRelayImage, imageBytes, readImageSource, MAX_IMAGE_BYTES, type ImageBytes } from "./relay-image"
import { validatePrivateImage } from "./private-image-validation"
import { ProviderError } from "./provider-network"
import * as workspace from "./private-workspace-service"
import type { PrivateAssetRecord, PrivateManifest, PrivateRunRecord } from "./private-workspace-records"
import type { PrivateRun, PrivateRunStatus } from "./private-workspace-types"

type Services = Pick<typeof workspace, "acceptPrivateRun" | "readPrivateRun" | "readPrivateAsset" | "readPrivateBase" | "setPrivateRunStatus" | "completePrivateRun" | "freezePrivateAnnotationExecution">
export type PrivateGenerationDependencies = {
  store: PrivateCosStore; service: Services; generate: typeof generateRelayImage; readSource: typeof readImageSource
  reauthorize: (identity: AccountIdentity) => Promise<unknown>
}
function dependencies(overrides: Partial<PrivateGenerationDependencies>): PrivateGenerationDependencies {
  return { store: overrides.store ?? createPrivateCosStore(), service: overrides.service ?? workspace,
    generate: overrides.generate ?? generateRelayImage, readSource: overrides.readSource ?? readImageSource,
    reauthorize: overrides.reauthorize ?? (identity => withTransaction(client => recheckAccount(client, identity))) }
}
function assetRecord(record: PrivateRunRecord, key: string, bytes: Uint8Array, mediaType: string, kind: "image" | "document", id: string = randomUUID(), name?: string): PrivateAssetRecord {
  return { id, ownerId: record.ownerId, creationId: record.public.creationId, runId: record.public.id, key, kind, mediaType, byteLength: bytes.length, sha256: bytesHash(bytes), ...(name ? { name } : {}) }
}
export async function readVerifiedPrivateAsset(asset: PrivateAssetRecord, store: PrivateCosStore): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const maximum = asset.kind === "document" ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES
  if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1 || asset.byteLength > maximum) throw new AccountError("PRIVATE_ASSET_INVALID", 502, "已保存文件信息无效，请联系管理员。")
  const object = await store.get(asset.key, maximum)
  if (object.bytes.length !== asset.byteLength || bytesHash(object.bytes) !== asset.sha256) throw new AccountError("PRIVATE_ASSET_INVALID", 502, "已保存文件核验失败，请稍后核对。")
  if (asset.kind === "image" && imageBytes(object.bytes).mediaType !== asset.mediaType) throw new AccountError("PRIVATE_ASSET_INVALID", 502, "已保存图片格式核验失败。")
  return { bytes: object.bytes, mediaType: asset.mediaType }
}

/** 一次受理最多一次模型调用；任何保存修复都调用独立的只读/补记流程。 */
export async function executePrivateGeneration(identity: AccountIdentity, input: ParsedPrivateGeneration, signal?: AbortSignal, overrides: Partial<PrivateGenerationDependencies> = {}): Promise<PrivateRun> {
  const dep = dependencies(overrides)
  const accepted = await dep.service.acceptPrivateRun(identity, input.command)
  const record = accepted.record
  if (!accepted.acquired) return record.public
  if (!accepted.settings) throw new AccountError("GENERATION_CONFIGURATION_INVALID", 503, "生成配置快照无效。")
  const prefix = record.outputKey.slice(0, -"/outputs/final".length)
  const providerPrompt = input.command.parentVersionId
    ? `以第一张图片为编辑基准，仅按本轮要求修改，保留未要求修改的内容。\n\n本轮修改要求：\n${input.effectivePrompt}`
    : input.effectivePrompt
  const manifest: PrivateManifest = {
    schema: 1, ownerId: record.ownerId, creationId: record.public.creationId, runId: record.public.id,
    fingerprint: record.fingerprint, status: "preparing", input: { ...input.command }, inputs: [], output: null,
    baseInputId: null, createdAt: record.public.createdAt, updatedAt: record.public.createdAt,
    effectivePrompt: providerPrompt, provider: { ...record.provider }, ...(input.command.annotationSnapshot ? { annotationExecution: null } : {}),
  }
  const saveManifest = async () => {
    manifest.updatedAt = Date.now()
    await dep.store.put(record.manifestKey, Buffer.from(JSON.stringify(manifest)), "application/json")
  }
  let modelStarted = false, resultKnown = false
  let stage: "inputs" | "reading" | "generation" | "output" | "manifest" | "metadata" = "inputs"
  try {
    const snapshot = input.command.annotationSnapshot ? validateAnnotationSnapshot(input.command.annotationSnapshot) : null
    if (snapshot && (input.references.length || (input.document && (input.document.imageInspection !== "none" || input.document.images.length)))) throw new AccountError("ANNOTATION_INPUT_INVALID", 400, "批注需要原图和辅助图两张输入，请移除额外参考图或含图文档。")
    if (snapshot && (!record.provider.annotationCapability || !isDeepStrictEqual(snapshot, record.public.annotationSnapshot) || snapshot.baseVersionId !== input.command.parentVersionId)) throw new AccountError("ANNOTATION_INPUT_INVALID", 400, "批注快照或已受理能力不匹配。")
    if (snapshot) {
      validateResolvedAnnotationCapability(record.provider.annotationCapability, { sha256: bytesHash, mappingId: record.public.mappingId, configurationRevision: record.provider.revision })
      const expectedPrompt = composePrompt(composeAnnotatedPrompt(input.command.prompt, snapshot), input.document?.name ?? "", input.document?.text ?? "")
      if (expectedPrompt !== input.effectivePrompt || expectedPrompt.length > 5000) throw new AccountError("ANNOTATION_INPUT_INVALID", 400, "批注、整体要求与文档内容不一致或超过 5000 字。")
    }
    signal?.throwIfAborted()
    await saveManifest()
    stage = "reading"
    const images: ImageBytes[] = []
    let originalBinding: AnnotationExecution["original"] | undefined
    if (input.command.parentVersionId) {
      const base = await dep.service.readPrivateBase(identity, input.command.creationId, input.command.parentVersionId)
      if (!base) throw new AccountError("BASE_VERSION_UNAVAILABLE", 409, "所选基准版本不可用，请重新选择。")
      const original = await validatePrivateImage((await readVerifiedPrivateAsset(base, dep.store)).bytes)
      images.push(original)
      if (snapshot) {
        if (base.id !== snapshot.image.assetId || original.pages !== 1 || (["width", "height", "orientation", "pages"] as const).some(key => original[key] !== snapshot.image[key])) throw new AccountError("ANNOTATION_INPUT_INVALID", 400, "批注坐标对应的原图尺寸、方向或版本已经不匹配，请重新加载基准。")
        originalBinding = { assetId: base.id, sha256: base.sha256, byteLength: base.byteLength, width: original.width, height: original.height, orientation: original.orientation, pages: 1 }
        const overlay = await renderAnnotationOverlay(original, snapshot)
        if (!["image/png", "image/jpeg"].includes(overlay.mediaType) || overlay.bytes.length > MAX_REFERENCE_BYTES) throw new AccountError("ANNOTATION_INPUT_INVALID", 400, "标注辅助图格式不支持或超过输入限制，请缩小原图后重新标记。")
        images.push(overlay)
      }
    }
    for (const reference of input.references) {
      signal?.throwIfAborted()
      let image: ImageBytes
      if ("image" in reference) image = reference.image
      else {
        assertPrivateReferenceSource(reference.source)
        if (reference.source.startsWith("/api/images/")) {
          const asset = await dep.service.readPrivateAsset(identity, reference.source.slice("/api/images/".length), "image")
          image = imageBytes((await readVerifiedPrivateAsset(asset, dep.store)).bytes)
        } else image = await dep.readSource(reference.source, signal)
      }
      if (image.bytes.length > MAX_REFERENCE_BYTES) throw new AccountError("INVALID_INPUT", 400, "单张补充参考图不能超过 10 MB。")
      images.push(image)
    }
    const documentImages = input.document?.images ?? []
    if (images.length + documentImages.length > 2 || (input.command.parentVersionId && !images.length)) throw new AccountError("INVALID_INPUT", 400, "原图和参考图数量不符合接口要求。")
    const allImages = [...images, ...documentImages]
    for (const image of allImages) await validatePrivateImage(image.bytes)
    stage = "inputs"
    if (input.document) {
      const doc = assetRecord(record, `${prefix}/inputs/document`, input.document.bytes, input.document.mediaType, "document", randomUUID(), input.document.name)
      await dep.store.put(doc.key, input.document.bytes, doc.mediaType)
      manifest.inputs.push(doc)
      await saveManifest()
    }
    for (const [index, image] of allImages.entries()) {
      signal?.throwIfAborted()
      const suffix = index < images.length ? `reference-${index + 1}` : `document-image-${index - images.length + 1}`
      const asset = assetRecord(record, `${prefix}/inputs/${suffix}`, image.bytes, image.mediaType, "image")
      await dep.store.put(asset.key, image.bytes, image.mediaType)
      manifest.inputs.push(asset)
      if (input.command.parentVersionId && index === 0) manifest.baseInputId = asset.id
      await saveManifest()
    }
    if (snapshot) {
      if (!originalBinding || !record.provider.annotationCapability) throw new AccountError("ANNOTATION_INPUT_INVALID", 400, "批注缺少原始图片或能力证据。")
      const inputs = manifest.inputs.filter(asset => asset.kind === "image")
      const execution = validateAnnotationExecution({ schema: 1, expression: "overlay-v1", renderVersion: 1,
        snapshotSha256: bytesHash(serializeAnnotationSnapshot(snapshot)), original: originalBinding,
        inputs: inputs.map((asset, index) => ({ role: index === 0 ? "original" : "overlay", id: asset.id, key: asset.key, sha256: asset.sha256, byteLength: asset.byteLength })),
        capability: record.provider.annotationCapability,
      })
      await dep.service.freezePrivateAnnotationExecution(record.ownerId, record.public.id, execution)
      manifest.annotationExecution = execution
      await saveManifest()
    }
    await dep.reauthorize(identity)
    signal?.throwIfAborted()
    manifest.status = "generating"
    await saveManifest()
    await dep.service.setPrivateRunStatus(record.ownerId, record.public.id, "generating")
    // 必需的网络写入完成后再核对；禁止在慢COS写入期间被撤销的任务继续付费调用。
    await dep.reauthorize(identity)
    signal?.throwIfAborted()
    stage = "generation"
    modelStarted = true
    const result = await validatePrivateImage((await dep.generate(accepted.settings, {
      model: record.provider.modelId, prompt: providerPrompt, aspectRatio: input.command.aspectRatio,
      quality: input.command.quality, images: allImages,
    }, signal)).bytes, "MODEL_OUTPUT_INVALID")
    resultKnown = true
    stage = "output"
    manifest.output = assetRecord(record, record.outputKey, result.bytes, result.mediaType, "image", record.outputAssetId)
    manifest.status = "saving"
    // 数据库瞬时失联不能妨碍把已经付费获得的图片写入固定恢复键。
    await dep.service.setPrivateRunStatus(record.ownerId, record.public.id, "saving").catch(() => {})
    await dep.store.put(record.outputKey, result.bytes, result.mediaType)
    stage = "manifest"
    manifest.status = "complete"
    await saveManifest()
    stage = "metadata"
    return await dep.service.completePrivateRun(record.ownerId, record.public.id, [...manifest.inputs, manifest.output])
  } catch (error) {
    const knownFailure = error instanceof AccountError && ["BASE_VERSION_UNAVAILABLE", "REFERENCE_INVALID", "MODEL_OUTPUT_INVALID", "ANNOTATION_INPUT_INVALID"].includes(error.code) ? error.code
      : error instanceof AccountError && ["UNAUTHENTICATED", "PASSWORD_CHANGE_REQUIRED", "FORBIDDEN"].includes(error.code) ? "ACCOUNT_UNAVAILABLE"
      : error instanceof ProviderError && ["PROVIDER_AUTH_REJECTED", "PROVIDER_REQUEST_REJECTED", "PROVIDER_RATE_LIMITED", "PROVIDER_UPSTREAM_FAILED"].includes(error.code ?? "") ? error.code
      : undefined
    const definiteFailure = knownFailure && knownFailure !== "PROVIDER_UPSTREAM_FAILED"
    const status: PrivateRunStatus = resultKnown ? "save_pending" : modelStarted && !definiteFailure ? "unknown" : "failed"
    const failureCode = resultKnown
      ? stage === "metadata" ? "METADATA_SAVE_FAILED" : stage === "manifest" ? "MANIFEST_SAVE_FAILED" : "OUTPUT_SAVE_FAILED"
      : knownFailure ?? (modelStarted ? "GENERATION_UNKNOWN" : signal?.aborted ? "REQUEST_ABORTED" : stage === "reading" ? "INPUT_READ_FAILED" : "INPUT_SAVE_FAILED")
    // 若完成清单已经写入，保留它作为修复证据，不降级覆盖。
    if (stage !== "metadata") {
      manifest.status = status
      await saveManifest().catch(() => {})
    }
    await dep.service.setPrivateRunStatus(record.ownerId, record.public.id, status, failureCode).catch(() => {})
    return { ...record.public, status, imageUrl: null, failureCode, updatedAt: Date.now() }
  }
}

function normalizedManifestCommand(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid command")
  const command = value as Record<string, unknown>
  const fields = ["creationId", "clientRequestId", "fingerprint", "parentVersionId", "mappingId", "configRevision", "prompt", "aspectRatio", "quality", "mode"]
  if (fields.some(key => !Object.hasOwn(command, key)) || Object.keys(command).some(key => !fields.includes(key) && key !== "annotationSnapshot")) throw new Error("invalid command")
  const result = Object.fromEntries(fields.map(key => [key, command[key]]))
  if (command.annotationSnapshot != null) result.annotationSnapshot = validateAnnotationSnapshot(command.annotationSnapshot)
  return result
}
function expectedCommand(record: PrivateRunRecord): Record<string, unknown> {
  const run = record.public
  return normalizedManifestCommand({ creationId: run.creationId, clientRequestId: run.id, fingerprint: record.fingerprint,
    parentVersionId: run.parentVersionId, mappingId: run.mappingId, configRevision: record.provider.revision,
    prompt: run.prompt, aspectRatio: run.aspectRatio, quality: run.quality, mode: run.mode, annotationSnapshot: run.annotationSnapshot })
}
function matchingAsset(value: unknown, record: PrivateRunRecord, output: boolean): value is PrivateAssetRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as PrivateAssetRecord
  const prefix = record.outputKey.slice(0, -"/outputs/final".length)
  return item.ownerId === record.ownerId && item.creationId === record.public.creationId && item.runId === record.public.id &&
    typeof item.id === "string" && /^[0-9a-f-]{36}$/i.test(item.id) &&
    Object.keys(item).every(key => ["id", "ownerId", "creationId", "runId", "key", "kind", "mediaType", "byteLength", "sha256", "name"].includes(key)) &&
    typeof item.key === "string" && (output ? item.key === record.outputKey && item.id === record.outputAssetId && item.kind === "image" :
      ((item.key === `${prefix}/inputs/document` && item.kind === "document") ||
      (["reference-1", "reference-2", "document-image-1", "document-image-2"].some(suffix => item.key === `${prefix}/inputs/${suffix}`) && item.kind === "image"))) &&
    typeof item.mediaType === "string" && Number.isSafeInteger(item.byteLength) && item.byteLength > 0 && /^[0-9a-f]{64}$/.test(item.sha256)
}

/** 只核对固定对象与补记数据库，不持有Token，也不调用模型。 */
export async function repairPrivateGeneration(identity: AccountIdentity, runId: string, overrides: Partial<PrivateGenerationDependencies> = {}): Promise<PrivateRun> {
  const dep = dependencies(overrides)
  const record = await dep.service.readPrivateRun(identity, runId)
  if (record.public.status === "complete") return record.public
  if (["preparing", "generating", "saving"].includes(record.public.status) && record.deadlineAt > Date.now()) throw new AccountError("RUN_STILL_RUNNING", 409, "任务仍在处理，请先查看状态。")
  let manifest: PrivateManifest
  try {
    const raw = await dep.store.get(record.manifestKey, MAX_PRIVATE_MANIFEST_BYTES)
    manifest = JSON.parse(Buffer.from(raw.bytes).toString("utf8")) as PrivateManifest
    const fields = ["schema", "ownerId", "creationId", "runId", "fingerprint", "status", "input", "inputs", "output", "baseInputId", "createdAt", "updatedAt", "effectivePrompt", "provider", "annotationExecution"]
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || Object.keys(manifest).some(key => !fields.includes(key)) ||
      !["preparing", "generating", "saving", "complete", "failed", "unknown", "save_pending"].includes(manifest.status) ||
      manifest.createdAt !== record.public.createdAt || !Number.isSafeInteger(manifest.updatedAt) || manifest.updatedAt < manifest.createdAt ||
      typeof manifest.effectivePrompt !== "string" || manifest.effectivePrompt.length > 5200 || manifest.effectivePrompt.includes("\0") ||
      manifest.schema !== 1 || manifest.ownerId !== record.ownerId || manifest.creationId !== record.public.creationId || manifest.runId !== record.public.id || manifest.fingerprint !== record.fingerprint ||
      !Array.isArray(manifest.inputs) || manifest.inputs.length > 3 || !manifest.inputs.every(asset => matchingAsset(asset, record, false)) ||
      (manifest.output !== null && !matchingAsset(manifest.output, record, true)) ||
      !isDeepStrictEqual(normalizedManifestCommand(manifest.input), expectedCommand(record)) ||
      !isDeepStrictEqual(manifest.provider, record.provider)) throw new Error("invalid manifest")
    const keys = new Set(manifest.inputs.map(asset => asset.key))
    if (keys.size !== manifest.inputs.length || new Set(manifest.inputs.map(asset => asset.id)).size !== manifest.inputs.length || manifest.inputs.some(asset => asset.id === record.outputAssetId) || (record.public.parentVersionId && !manifest.inputs.some(asset => asset.id === manifest.baseInputId && asset.kind === "image"))) throw new Error("invalid inputs")
    const verified = new Map<string, Awaited<ReturnType<typeof validatePrivateImage>>>()
    let documentText = "", documentName = ""
    let documentFingerprint: { name: string; sha256: string; mediaType: string } | null = null
    for (const asset of manifest.inputs) {
      const object = await readVerifiedPrivateAsset(asset, dep.store)
      if (asset.kind === "image") verified.set(asset.id, await validatePrivateImage(object.bytes))
      if (asset.kind === "document" && record.public.annotationSnapshot) {
        if (documentFingerprint || !asset.name) throw new Error("invalid annotation document")
        documentFingerprint = { name: asset.name, sha256: asset.sha256, mediaType: asset.mediaType }
        // Restored text has a deliberately text/plain identity even if its display name ends in PDF.
        const parsed = asset.mediaType === "text/plain"
          ? { text: Buffer.from(object.bytes).toString("utf8").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim(), imageInspection: "none" }
          : await parseDocument(new File([new Uint8Array(object.bytes)], asset.name, { type: asset.mediaType }))
        if (parsed.imageInspection !== "none") throw new Error("annotation document contains unconfirmed images")
        documentName = asset.name; documentText = parsed.text
      }
    }
    const snapshot = record.public.annotationSnapshot
    if (snapshot) {
      const capabilityVerification = { sha256: bytesHash, mappingId: record.public.mappingId, configurationRevision: record.provider.revision }
      const execution = validateAnnotationExecution(record.annotationExecution, capabilityVerification)
      if (!isDeepStrictEqual(validateAnnotationExecution(manifest.annotationExecution, capabilityVerification), execution) ||
          execution.snapshotSha256 !== bytesHash(serializeAnnotationSnapshot(snapshot)) ||
          !isDeepStrictEqual(execution.capability, record.provider.annotationCapability) ||
          manifest.baseInputId !== execution.inputs[0].id) throw new Error("annotation binding mismatch")
      const images = manifest.inputs.filter(asset => asset.kind === "image")
      if (images.length !== 2 || execution.inputs.some(input => !images.some(asset => asset.id === input.id && asset.key === input.key && asset.sha256 === input.sha256 && asset.byteLength === input.byteLength))) throw new Error("annotation roles mismatch")
      const base = await dep.service.readPrivateBase(identity, record.public.creationId, record.public.parentVersionId)
      if (!base || base.id !== execution.original.assetId || base.id !== snapshot.image.assetId || base.sha256 !== execution.original.sha256 || base.byteLength !== execution.original.byteLength) throw new Error("annotation original mismatch")
      const original = await validatePrivateImage((await readVerifiedPrivateAsset(base, dep.store)).bytes)
      const originalInput = verified.get(execution.inputs[0].id)!, overlay = verified.get(execution.inputs[1].id)!
      const size = orientedImageSize(snapshot.image)
      if ((["width", "height", "orientation", "pages"] as const).some(key => original[key] !== snapshot.image[key] || original[key] !== execution.original[key] || originalInput[key] !== original[key]) ||
          overlay.width !== size.width || overlay.height !== size.height || overlay.orientation !== 1 || overlay.pages !== 1 || !["image/png", "image/jpeg"].includes(overlay.mediaType)) throw new Error("annotation dimensions mismatch")
      const fingerprint = bytesHash(JSON.stringify({ ...expectedCommand(record), fingerprint: "", references: [], document: documentFingerprint }))
      if (fingerprint !== record.fingerprint) throw new Error("annotation request fingerprint mismatch")
      const composed = composePrompt(composeAnnotatedPrompt(record.public.prompt, snapshot), documentName, documentText)
      if (manifest.effectivePrompt !== `以第一张图片为编辑基准，仅按本轮要求修改，保留未要求修改的内容。\n\n本轮修改要求：\n${composed}`) throw new Error("annotation prompt mismatch")
    } else if (record.annotationExecution || manifest.annotationExecution) throw new Error("unexpected annotation execution")
  } catch { throw new AccountError("RUN_REPAIR_UNAVAILABLE", 503, "任务清单或输入暂时无法核对，未重新调用模型。请稍后查看状态。") }
  let output: PrivateAssetRecord
  try {
    const object = await dep.store.get(record.outputKey, MAX_IMAGE_BYTES)
    const image = await validatePrivateImage(object.bytes, "MODEL_OUTPUT_INVALID")
    output = assetRecord(record, record.outputKey, image.bytes, image.mediaType, "image", record.outputAssetId)
    if (manifest.output && (output.sha256 !== manifest.output.sha256 || output.byteLength !== manifest.output.byteLength || output.mediaType !== manifest.output.mediaType)) throw new Error("output mismatch")
  } catch { throw new AccountError("RUN_OUTPUT_UNCONFIRMED", 409, "尚未核对到完整输出，结果仍不明；没有重新调用模型。") }
  await dep.reauthorize(identity)
  manifest.output = output
  manifest.status = "complete"
  manifest.updatedAt = Date.now()
  try {
    await dep.store.put(record.manifestKey, Buffer.from(JSON.stringify(manifest)), "application/json")
    return await dep.service.completePrivateRun(record.ownerId, record.public.id, [...manifest.inputs, output])
  } catch { throw new AccountError("RUN_REPAIR_SAVE_PENDING", 503, "已核对到图片，但保存补记暂未完成。可以稍后再次补记，不会重新生成。") }
}
