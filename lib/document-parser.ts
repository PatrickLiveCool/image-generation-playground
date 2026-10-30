import { imageBytes, type ImageBytes } from "./relay-image"
import { documentExtension, isDocumentFile, MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARS } from "./document-context"
import { ProviderError } from "./provider-network"
import { inspectDocxImages, inspectPdfImages, inspectTextDocument, MAX_PDF_IMAGE_PIXELS, UnsafePdfError, type InspectedPdfPage, type DocumentImageInspection } from "./document-image-inspection"

export type ParsedDocument = {
  name: string
  mediaType: string
  bytes: Uint8Array
  text: string
  images: ImageBytes[]
  imageInspection: DocumentImageInspection
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

async function parseDocx(bytes: Uint8Array): Promise<{ text: string; images: ImageBytes[]; imageInspection: DocumentImageInspection }> {
  const inspected = await inspectDocxImages(bytes)
  if (!inspected.safeToExtract) throw new ProviderError("DOCX 结构损坏或超过安全解压限制，请改用纯 TXT。", 400)
  let imageInspection = inspected.imageInspection
  const mammothModule = await import("mammoth")
  const mammoth = mammothModule.default ?? mammothModule
  const buffer = Buffer.from(bytes)
  const textResult = await mammoth.extractRawText({ buffer })
  const images: ImageBytes[] = []
  try { await mammoth.convertToHtml({ buffer }, {
    externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async image => {
      imageInspection = "present"
      if (images.length < MAX_DOCUMENT_IMAGES) addImage(images, new Uint8Array(await image.read()))
      return { src: "" }
    }),
  }) } catch { if (imageInspection !== "present") imageInspection = "unknown" }
  return { text: normalizeText(textResult.value), images, imageInspection }
}

async function parsePdf(bytes: Uint8Array): Promise<{ text: string; images: ImageBytes[]; imageInspection: DocumentImageInspection }> {
  const text: string[] = [], images: ImageBytes[] = []
  let characters = 0, imagePixels = 0
  try {
    const imageInspection = await inspectPdfImages(bytes, async ({ page, operators, pdf, checkBudget }: InspectedPdfPage) => {
      const reader = page.streamTextContent().getReader()
      try {
        while (true) {
          checkBudget()
          const chunk = await reader.read()
          checkBudget()
          if (chunk.done) break
          for (const item of chunk.value.items) if (typeof item.str === "string") {
            const value = item.str + (item.hasEOL ? "\n" : " ")
            characters += value.length
            if (characters > MAX_DOCUMENT_CHARS) throw new ProviderError(`文档文字不能超过 ${MAX_DOCUMENT_CHARS} 个字符，请先精简文档。`, 400)
            text.push(value)
          }
        }
      } finally { reader.releaseLock() } // The shared loading task destroys unfinished streams on failure.
      text.push("\n")
      if (!operators) throw new ProviderError("PDF 图像内容无法安全读取，请改用纯 TXT。", 400)
      // Inspect every page, but resolve and encode only the first two usable images.
      for (let index = 0; index < operators.fnArray.length && images.length < MAX_DOCUMENT_IMAGES; index++) {
        checkBudget()
        const operation = operators.fnArray[index]
        if (![pdf.OPS.paintImageXObject, pdf.OPS.paintInlineImageXObject, pdf.OPS.paintImageXObjectRepeat].includes(operation)) continue
        const source = operators.argsArray[index][0]
        const image = typeof source === "string"
          ? await new Promise<{ width: number; height: number; kind: number; data: Uint8Array | Uint8ClampedArray } | null>(resolve => (page.commonObjs.has(source) ? page.commonObjs : page.objs).get(source, resolve))
          : source as { width: number; height: number; kind: number; data: Uint8Array | Uint8ClampedArray } | null
        checkBudget()
        if (!image) throw new ProviderError("PDF 图像内容无法安全读取，请改用纯 TXT。", 400)
        const { width, height, kind, data } = image, pixels = width * height
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(pixels) || pixels > MAX_PDF_IMAGE_PIXELS) throw new UnsafePdfError()
        if (width <= 64 || height <= 64) continue
        imagePixels += pixels
        if (imagePixels > MAX_PDF_IMAGE_PIXELS) throw new UnsafePdfError()
        if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw new ProviderError("PDF 图像格式无法安全读取，请改用纯 TXT。", 400)
        const { createCanvas } = await import("@napi-rs/canvas")
        checkBudget()
        const canvas = createCanvas(width, height), context = canvas.getContext("2d"), rgba = context.createImageData(width, height)
        if (kind === pdf.ImageKind.RGBA_32BPP && data.length === pixels * 4) rgba.data.set(data)
        else if (kind === pdf.ImageKind.RGB_24BPP && data.length === pixels * 3) {
          for (let pixel = 0; pixel < pixels; pixel++) { rgba.data[pixel * 4] = data[pixel * 3]; rgba.data[pixel * 4 + 1] = data[pixel * 3 + 1]; rgba.data[pixel * 4 + 2] = data[pixel * 3 + 2]; rgba.data[pixel * 4 + 3] = 255 }
        } else if (kind === pdf.ImageKind.GRAYSCALE_1BPP && data.length === Math.ceil(width / 8) * height) {
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const pixel = (y * width + x) * 4, gray = data[y * Math.ceil(width / 8) + (x >> 3)] & (128 >> (x % 8)) ? 255 : 0
            rgba.data[pixel] = rgba.data[pixel + 1] = rgba.data[pixel + 2] = gray; rgba.data[pixel + 3] = 255
          }
        } else throw new ProviderError("PDF 图像格式无法安全读取，请改用纯 TXT。", 400)
        context.putImageData(rgba, 0, 0)
        checkBudget()
        const encoded = await canvas.encode("png")
        checkBudget()
        images.push(imageBytes(encoded))
      }
    })
    return { text: normalizeText(text.join("")), images, imageInspection }
  } catch (error) {
    if (error instanceof UnsafePdfError) throw new ProviderError(error.message, 400)
    throw error
  }
}

export async function parseDocument(file: File): Promise<ParsedDocument> {
  if (!file.name || file.name.length > 240 || /[\u0000-\u001f\u007f]/.test(file.name)) throw new ProviderError("文档名称无效。", 400)
  if (!file.size || file.size > MAX_DOCUMENT_BYTES) throw new ProviderError("文档为空或超过 10 MB。", 400)
  if (!isDocumentFile(file)) throw new ProviderError("目前支持 TXT、MD、CSV、JSON、HTML、XML、PDF 和 DOCX 文档。", 400)
  const extension = documentExtension(file.name)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if ((Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-" && extension !== "pdf") || (bytes[0] === 0x50 && bytes[1] === 0x4b && extension !== "docx")) throw new ProviderError("文档内容与文件类型不一致，请使用原始扩展名。", 400)
  if (extension === "pdf" && Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new ProviderError("PDF 文件内容无效，请重新选择文件。", 400)
  if (extension === "docx" && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new ProviderError("DOCX 文件内容无效，请重新选择文件。", 400)
  const sourceBytes = new Uint8Array(bytes)
  let text: string
  let images: ImageBytes[] = []
  let imageInspection: DocumentImageInspection = "unknown"
  if (extension === "pdf") ({ text, images, imageInspection } = await parsePdf(new Uint8Array(sourceBytes)))
  else if (extension === "docx") ({ text, images, imageInspection } = await parseDocx(new Uint8Array(sourceBytes)))
  else { text = normalizeText(Buffer.from(sourceBytes).toString("utf8")); imageInspection = inspectTextDocument(sourceBytes, extension) }
  if (!text && !images.length) throw new ProviderError("文档没有可读取的文字或图片内容。", 400)
  if (text.length > MAX_DOCUMENT_CHARS) throw new ProviderError(`文档文字不能超过 ${MAX_DOCUMENT_CHARS} 个字符，请先精简文档。`, 400)
  return { name: file.name, mediaType: documentMediaType(extension), bytes: sourceBytes, text, images, imageInspection }
}
