import { imageBytes, type ImageBytes } from "./relay-image"
import { documentExtension, isDocumentFile, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARS } from "./document-context"
import { ProviderError } from "./provider-network"

export type ParsedDocument = {
  name: string
  mediaType: string
  bytes: Uint8Array
  text: string
  images: ImageBytes[]
}

const MAX_DOCUMENT_IMAGES = 2

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim()
}

function documentMediaType(extension: ReturnType<typeof documentExtension>): string {
  return extension === "pdf" ? "application/pdf"
    : extension === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : extension === "html" ? "text/html"
        : extension === "json" ? "application/json"
          : extension === "csv" ? "text/csv"
            : extension === "xml" ? "application/xml"
              : extension === "md" ? "text/markdown" : "text/plain"
}

function addImage(images: ImageBytes[], bytes: Uint8Array): void {
  if (images.length >= MAX_DOCUMENT_IMAGES) return
  try { images.push(imageBytes(bytes)) } catch { /* Skip unsupported embedded image formats. */ }
}

async function parseDocx(bytes: Uint8Array): Promise<{ text: string; images: ImageBytes[] }> {
  const mammothModule = await import("mammoth")
  const mammoth = mammothModule.default ?? mammothModule
  const buffer = Buffer.from(bytes)
  const textResult = await mammoth.extractRawText({ buffer })
  const images: ImageBytes[] = []
  await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.imgElement(async image => {
      addImage(images, new Uint8Array(await image.read()))
      return { src: "" }
    }),
  })
  return { text: normalizeText(textResult.value), images }
}

async function parsePdf(bytes: Uint8Array): Promise<{ text: string; images: ImageBytes[] }> {
  const { PDFParse } = await import("pdf-parse")
  const parser = new PDFParse({ data: bytes })
  try {
    const textResult = await parser.getText({ pageJoiner: "\n" })
    const images: ImageBytes[] = []
    try {
      const imageResult = await parser.getImage({ imageThreshold: 64, imageBuffer: true, imageDataUrl: false })
      for (const page of imageResult.pages) for (const image of page.images) {
        if (image.data?.length) addImage(images, new Uint8Array(image.data))
        if (images.length >= MAX_DOCUMENT_IMAGES) break
      }
    } catch { /* Text extraction remains useful for PDFs whose embedded images cannot be decoded. */ }
    return { text: normalizeText(textResult.text), images }
  } finally {
    await parser.destroy()
  }
}

export async function parseDocument(file: File): Promise<ParsedDocument> {
  if (!file.size || file.size > MAX_DOCUMENT_BYTES) throw new ProviderError("文档为空或超过 10 MB。", 400)
  if (!isDocumentFile(file)) throw new ProviderError("目前支持 TXT、MD、CSV、JSON、HTML、XML、PDF 和 DOCX 文档。", 400)
  const extension = documentExtension(file.name)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (extension === "pdf" && Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new ProviderError("PDF 文件内容无效，请重新选择文件。", 400)
  if (extension === "docx" && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new ProviderError("DOCX 文件内容无效，请重新选择文件。", 400)
  const sourceBytes = new Uint8Array(bytes)
  let text: string
  let images: ImageBytes[] = []
  if (extension === "pdf") ({ text, images } = await parsePdf(new Uint8Array(sourceBytes)))
  else if (extension === "docx") ({ text, images } = await parseDocx(new Uint8Array(sourceBytes)))
  else text = normalizeText(Buffer.from(sourceBytes).toString("utf8"))
  if (!text && !images.length) throw new ProviderError("文档没有可读取的文字或图片内容。", 400)
  if (text.length > MAX_DOCUMENT_CHARS) throw new ProviderError(`文档文字不能超过 ${MAX_DOCUMENT_CHARS} 个字符，请先精简文档。`, 400)
  return { name: file.name, mediaType: documentMediaType(extension), bytes: sourceBytes, text, images }
}
