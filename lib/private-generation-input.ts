import { validateAnnotationSnapshot, composeAnnotatedPrompt, type AnnotationSnapshot } from "./image-annotations"
import { createHash } from "node:crypto"
import { AccountError, invalidInput } from "./auth/errors"
import { composePrompt, MAX_DOCUMENT_CHARS } from "./document-context"
import { parseDocument, type ParsedDocument } from "./document-parser"
import { imageBytes, type ImageBytes } from "./relay-image"
import type { RunCommand } from "./private-workspace-records"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_REQUEST_BYTES = 32 * 1024 * 1024
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const FIELDS = new Set(["creationId", "clientRequestId", "parentVersionId", "mappingId", "configRevision", "prompt", "aspectRatio", "quality", "mode", "image1", "image2", "image1Url", "image2Url", "document", "documentName", "documentText", "annotationSnapshot"])
export type PrivateReference = { image: ImageBytes } | { source: string }
export type ParsedPrivateGeneration = { command: RunCommand; references: PrivateReference[]; document?: ParsedDocument; effectivePrompt: string }
export const bytesHash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

/** 限制实际读取字节，而不单凭客户端 Content-Length。 */
export async function readPrivateGenerationForm(request: Request, timeoutMs = 30_000): Promise<FormData> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw invalidInput("上传时限无效。")
  const type = request.headers.get("content-type") ?? ""
  const length = request.headers.get("content-length")
  if (!/^multipart\/form-data\s*;\s*boundary=/.test(type) || type.length > 200 ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES))) throw invalidInput("生成请求格式错误或超过 32 MiB。")
  if (!request.body) throw invalidInput("生成请求为空。")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0, count = 0
  let stop!: () => void
  const stopped = new Promise<never>((_, reject) => { stop = () => reject(new AccountError("REQUEST_BODY_TIMEOUT", 408, "上传已取消或超时，请检查文件后重新提交。")) })
  const timer = setTimeout(stop, timeoutMs)
  request.signal.addEventListener("abort", stop, { once: true })
  if (request.signal.aborted) stop()
  try {
    while (true) {
      const part = await Promise.race([reader.read(), stopped])
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_REQUEST_BYTES || ++count > MAX_REQUEST_BYTES) {
        void reader.cancel().catch(() => {})
        throw invalidInput("生成请求超过 32 MiB。")
      }
      chunks.push(part.value)
    }
    return await Promise.race([new Response(Buffer.concat(chunks), { headers: { "Content-Type": type } }).formData(), stopped])
  } catch (error) {
    if (error instanceof Error && error.name === "AccountError") throw error
    throw invalidInput("无法读取生成请求，请检查文件后重新提交。")
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener("abort", stop)
    void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* 未完成的流取消不能阻塞请求结束。 */ }
  }
}

function text(form: FormData, key: string, maximum: number, optional = false): string {
  const value = form.get(key)
  if (optional && value === null) return ""
  if (typeof value !== "string" || value.length > maximum || value.includes("\0") || (!optional && !value.trim())) throw invalidInput(`生成参数 ${key} 无效。`)
  return value
}

/** 自有对象必须走授权资产ID；绝对URL、旧能力和桶地址不能转为公网代理。 */
export function assertPrivateReferenceSource(source: string, environment: NodeJS.ProcessEnv = process.env): void {
  if (/^\/api\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source)) return
  if (source.startsWith("data:")) {
    if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/\s]+={0,2}$/.test(source) || source.length > MAX_REFERENCE_BYTES * 1.4) throw invalidInput("参考图数据格式无效或超过 10 MB。")
    return
  }
  let url: URL
  try { url = new URL(source) } catch { throw invalidInput("请输入有效的公网 HTTPS 参考图地址。") }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || source.length > 8192) throw invalidInput("请输入有效的公网 HTTPS 参考图地址。")
  const ownHosts = new Set<string>()
  for (const value of [environment.BETTER_AUTH_URL, environment.COS_DOMAIN]) {
    try { if (value) ownHosts.add(new URL(value).hostname.toLowerCase()) } catch { /* 配置由各自模块校验；此处不返回原始配置。 */ }
  }
  if (environment.COS_BUCKET && environment.COS_REGION) ownHosts.add(`${environment.COS_BUCKET}.cos.${environment.COS_REGION}.myqcloud.com`.toLowerCase())
  let path: string
  try { path = decodeURIComponent(url.pathname) } catch { throw invalidInput("参考图地址无效。") }
  if (ownHosts.has(url.hostname.toLowerCase()) || /^\/api\/(?:assets|images|documents)(?:\/|$)/.test(path) || /\/image-playground\/(?:private|runs)\//.test(path)) {
    throw invalidInput("本应用图片请使用当前账号的已保存版本或受保护图片地址。")
  }
}

export async function parsePrivateGenerationForm(form: FormData): Promise<ParsedPrivateGeneration> {
  for (const key of form.keys()) if (!FIELDS.has(key) || form.getAll(key).length !== 1) throw invalidInput("生成请求包含重复或不支持的字段。")
  const creationId = text(form, "creationId", 36).toLowerCase()
  const clientRequestId = text(form, "clientRequestId", 36).toLowerCase()
  const parentVersionId = text(form, "parentVersionId", 36, true).toLowerCase() || null
  if (!UUID.test(creationId) || !UUID.test(clientRequestId) || (parentVersionId && (!UUID.test(parentVersionId) || parentVersionId === clientRequestId))) throw invalidInput("创作或版本标识无效。")
  const mappingId = text(form, "mappingId", 128)
  if (mappingId !== mappingId.trim() || /[\u0000-\u001f\u007f]/.test(mappingId)) throw invalidInput("请重新选择模型。")
  const revision = text(form, "configRevision", 10)
  if (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) >= 2_147_483_647) throw invalidInput("模型配置版本无效，请刷新目录。")
  let annotationSnapshot: AnnotationSnapshot | undefined
  if (form.has("annotationSnapshot")) {
    try { annotationSnapshot = validateAnnotationSnapshot(JSON.parse(text(form, "annotationSnapshot", 128 * 1024))) }
    catch { throw invalidInput("批注快照无效，请检查区域和说明后重新提交。") }
    if (!parentVersionId || annotationSnapshot.baseVersionId !== parentVersionId) throw invalidInput("批注必须对应本次所选基准版本。")
    if (["image1", "image2", "image1Url", "image2Url"].some(key => form.has(key))) throw invalidInput("批注的原图和辅助图已占满两张输入，请移除补充参考图。")
  }
  const prompt = text(form, "prompt", 5000, Boolean(annotationSnapshot))
  const aspectRatio = text(form, "aspectRatio", 16)
  const quality = text(form, "quality", 8)
  const requestedMode = text(form, "mode", 16)
  if (!["square", "portrait", "landscape", "wide", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5"].includes(aspectRatio) ||
    !["auto", "low", "medium", "high"].includes(quality) || !["text-to-image", "image-editing"].includes(requestedMode)) throw invalidInput("生成参数无效。")
  const references: PrivateReference[] = []
  const referenceFingerprints: unknown[] = []
  for (const slot of ["image1", "image2"]) {
    const file = form.get(slot)
    const source = form.get(`${slot}Url`)
    if (file !== null && source !== null) throw invalidInput("同一参考图不能同时提交文件和链接。")
    if (file !== null) {
      if (!(file instanceof File) || !file.size || file.size > MAX_REFERENCE_BYTES) throw invalidInput("参考图片不能为空，且单张不能超过 10 MB。")
      const image = imageBytes(new Uint8Array(await file.arrayBuffer()))
      references.push({ image })
      referenceFingerprints.push({ slot, sha256: bytesHash(image.bytes) })
    } else if (source !== null) {
      if (typeof source !== "string" || !source.trim()) throw invalidInput("参考图地址不能为空。")
      const normalized = source.trim()
      assertPrivateReferenceSource(normalized)
      references.push({ source: normalized })
      // 指纹只保存摘要，不能将签名URL写入任务记录或日志。
      referenceFingerprints.push({ slot, sourceHash: bytesHash(normalized) })
    }
  }
  const file = form.get("document")
  const name = text(form, "documentName", 240, true)
  const restoredText = text(form, "documentText", MAX_DOCUMENT_CHARS, true)
  if (file !== null && (form.has("documentName") || form.has("documentText"))) throw invalidInput("文档文件和恢复文字不能重复提交。")
  let document: ParsedDocument | undefined
  if (file !== null) {
    if (!(file instanceof File) || !file.name || file.name.length > 240 || /[\u0000-\u001f\u007f]/.test(file.name)) throw invalidInput("文档格式无效。")
    document = await parseDocument(file)
  } else if (name || restoredText) {
    if (!name.trim() || !restoredText.trim() || /[\u0000-\u001f\u007f]/.test(name)) throw invalidInput("恢复的文档名称和文字不完整。")
    document = { name, mediaType: "text/plain", bytes: Buffer.from(restoredText), text: annotationSnapshot ? restoredText.replace(/\r\n?/g, "\n").trim() : restoredText, images: [], imageInspection: "none" }
  }
  if (annotationSnapshot && document && document.imageInspection !== "none") throw invalidInput("批注仅支持确认无图片的文档，请移除文档或改用纯 TXT。")
  let annotatedPrompt: string
  try { annotatedPrompt = annotationSnapshot ? composeAnnotatedPrompt(prompt, annotationSnapshot) : prompt }
  catch { throw invalidInput("批注与整体要求合计不能超过 5000 字。") }
  const effectivePrompt = composePrompt(annotatedPrompt, document?.name ?? "", document?.text ?? "")
  if (effectivePrompt.length > 5000) throw invalidInput("提示词和文档上下文合计不能超过 5000 字。")
  const imageCount = (annotationSnapshot ? 2 : Number(Boolean(parentVersionId))) + references.length + (document?.images.length ?? 0)
  if (imageCount > 2) throw invalidInput("原始基准、补充参考图和文档图片合计最多两张，请精简后提交。")
  if (requestedMode === "image-editing" && !imageCount) throw invalidInput("修改图片需要有效基准或参考图。")
  const mode = imageCount ? "image-editing" : "text-to-image"
  const command: RunCommand = { creationId, clientRequestId, fingerprint: "", parentVersionId, mappingId, configRevision: Number(revision), prompt, aspectRatio, quality, mode, ...(annotationSnapshot ? { annotationSnapshot } : {}) }
  command.fingerprint = bytesHash(JSON.stringify({ ...command, references: referenceFingerprints, document: document ? { name: document.name, sha256: bytesHash(document.bytes), mediaType: document.mediaType } : null }))
  return { command, references, document, effectivePrompt }
}
