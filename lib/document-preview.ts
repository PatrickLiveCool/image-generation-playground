import { accountIdentity, assertSameOrigin } from "./auth/guards"
import { AccountError, invalidInput } from "./auth/errors"
import { MAX_DOCUMENT_BYTES } from "./document-context"
import { parseDocument } from "./document-parser"
import { privateApiError, privateJson } from "./private-api"

type PreviewDependencies = { authorize: typeof accountIdentity; assertOrigin: typeof assertSameOrigin; parse: typeof parseDocument }
const MAX_PREVIEW_REQUEST_BYTES = MAX_DOCUMENT_BYTES + 64 * 1024

/** Separate bounded request reader: the preview endpoint cannot accept restored text or caller claims. */
export async function readDocumentPreviewForm(request: Request, timeoutMs = 30_000): Promise<File> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw invalidInput()
  const type = request.headers.get("content-type") ?? "", length = request.headers.get("content-length")
  if (!/^multipart\/form-data\s*;\s*boundary=/.test(type) || type.length > 200 ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_PREVIEW_REQUEST_BYTES)) || !request.body) throw invalidInput("请提交不超过 10 MB 的文档文件。")
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0, abort!: () => void
  const aborted = new Promise<never>((_, reject) => { abort = () => reject(new AccountError("REQUEST_BODY_TIMEOUT", 408, "文档上传已取消或超时。")) })
  const timeout = setTimeout(abort, timeoutMs)
  request.signal.addEventListener("abort", abort, { once: true })
  if (request.signal.aborted) abort()
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted])
      if (part.done) break
      size += part.value.length
      if (size > MAX_PREVIEW_REQUEST_BYTES) throw invalidInput("文档上传超过 10 MB。")
      chunks.push(part.value)
    }
    const form = await Promise.race([new Response(Buffer.concat(chunks), { headers: { "Content-Type": type } }).formData(), aborted])
    if ([...form.keys()].some(key => key !== "document") || form.getAll("document").length !== 1) throw invalidInput("文档预览仅接受一个 document 文件。")
    const file = form.get("document")
    if (!(file instanceof File) || !file.size || file.size > MAX_DOCUMENT_BYTES || !file.name || file.name.length > 240 || /[\u0000-\u001f\u007f]/.test(file.name)) throw invalidInput("文档名称、内容或大小无效。")
    return file
  } catch (error) {
    if (error instanceof AccountError) throw error
    throw invalidInput("无法读取文档上传，请重新选择文件。")
  } finally {
    clearTimeout(timeout); request.signal.removeEventListener("abort", abort)
    void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* Cancellation must not keep the response open. */ }
  }
}

export async function documentPreviewResponse(request: Request, supplied: Partial<PreviewDependencies> = {}): Promise<Response> {
  const dep: PreviewDependencies = { authorize: supplied.authorize ?? accountIdentity, assertOrigin: supplied.assertOrigin ?? assertSameOrigin, parse: supplied.parse ?? parseDocument }
  try {
    dep.assertOrigin(request)
    const identity = await dep.authorize(request.headers)
    const document = await dep.parse(await readDocumentPreviewForm(request))
    const current = await dep.authorize(request.headers)
    if (current.user.id !== identity.user.id || current.sessionId !== identity.sessionId) throw new AccountError("UNAUTHENTICATED", 401, "请重新登录。")
    return privateJson({ document: { name: document.name, text: document.text, imageInspection: document.imageInspection } })
  } catch (error) { return privateApiError(error) }
}
