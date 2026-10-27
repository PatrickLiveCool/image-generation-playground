export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_CHARS = 12_000

const DOCUMENT_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm", ".xml", ".pdf", ".docx"] as const
const DOCUMENT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/html",
  "application/xml",
  "text/xml",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
])

export function isDocumentFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return DOCUMENT_MIME_TYPES.has(file.type.toLowerCase()) || DOCUMENT_EXTENSIONS.some(extension => name.endsWith(extension))
}

export function validateDocumentFile(file: File): void {
  if (!file.size) throw new Error("文档为空，请选择有内容的文件。")
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error("文档不能超过 10 MB。")
  if (!isDocumentFile(file)) throw new Error("目前支持 TXT、MD、CSV、JSON、HTML、XML、PDF 和 DOCX 文档。")
}

export function documentExtension(fileName: string): "txt" | "md" | "csv" | "json" | "html" | "xml" | "pdf" | "docx" {
  const name = fileName.toLowerCase()
  if (name.endsWith(".pdf")) return "pdf"
  if (name.endsWith(".docx")) return "docx"
  if (name.endsWith(".csv")) return "csv"
  if (name.endsWith(".json")) return "json"
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html"
  if (name.endsWith(".xml")) return "xml"
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "md"
  return "txt"
}

export function composePrompt(prompt: string, documentName: string, documentText: string): string {
  const text = documentText.trim()
  if (!text) return prompt
  const name = documentName.trim() || "未命名文档"
  return `${prompt}\n\n【文档上下文：${name}】\n${text}\n【文档上下文结束】`
}
