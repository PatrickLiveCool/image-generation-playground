import { inflateSync } from "node:zlib"
import JSZip from "jszip"
import { DOMParser } from "@xmldom/xmldom"
import type { documentExtension } from "./document-context"
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api"

export type DocumentImageInspection = "none" | "present" | "unknown"
const MAX_XML_BYTES = 10 * 1024 * 1024
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024
export const MAX_DOCUMENT_PAGES = 200
const MAX_PDF_OPERATORS = 100_000
export const MAX_PDF_IMAGE_PIXELS = 8_000_000
const PDF_TIMEOUT_MS = 5000

function xmlDocument(text: string, html = false) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null
  let invalid = false
  const document = new DOMParser({ errorHandler: { warning() { invalid = true }, error() { invalid = true }, fatalError() { invalid = true } } }).parseFromString(text, html ? "text/html" : "application/xml")
  return !invalid && document.documentElement ? document : null
}
function strictText(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return null }
}

/** Text formats are never executed. Active/ambiguous markup cannot prove that no visual material exists. */
export function inspectTextDocument(bytes: Uint8Array, extension: ReturnType<typeof documentExtension>): DocumentImageInspection {
  const text = strictText(bytes)
  if (text === null || /\u0000/.test(text)) return "unknown"
  if (/!\s*\[|<\s*(?:[\w-]+:)?(?:img|image|imagedata|blip)\b|data\s*:\s*image\//i.test(text)) return "present"
  if (extension === "xml") return "unknown"
  if (extension !== "html") {
    if (/<\s*\/?\s*[a-z][\w:-]*(?:\s|\/?>)|<!DOCTYPE|<!ENTITY/i.test(text)) return "unknown"
    return "none"
  }
  const document = xmlDocument(text, true)
  if (!document) return "unknown"
  const safe = new Set(["html", "head", "body", "title", "meta", "p", "div", "span", "br", "hr", "a", "b", "i", "u", "em", "strong", "small", "sub", "sup", "pre", "code", "blockquote", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "h1", "h2", "h3", "h4", "h5", "h6"])
  let uncertain = false
  for (const element of Array.from(document.getElementsByTagName("*"))) {
    const name = element.localName.toLowerCase()
    const attributes = new Map(Array.from(element.attributes, attribute => [attribute.name.toLowerCase(), attribute.value]))
    if (["img", "image", "picture"].includes(name) || ["poster", "background", "srcset"].some(attribute => attributes.has(attribute)) || (name === "input" && attributes.get("type")?.toLowerCase() === "image")) return "present"
    if (!safe.has(name) || attributes.has("style") || [...attributes.keys()].some(name => name.startsWith("on"))) uncertain = true
  }
  return uncertain ? "unknown" : "none"
}

type ZipEntry = { name: string; byteLength: number }
/** Public ZIP container structure only; no access to JSZip's private compressed-data fields. */
function boundedZipDirectory(bytes: Uint8Array): ZipEntry[] | null {
  try {
    const data = Buffer.from(bytes)
    let end = -1
    for (let at = data.length - 22; at >= Math.max(0, data.length - 65_557); at--) {
      if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) { end = at; break }
    }
    if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) return null
    const count = data.readUInt16LE(end + 10), start = data.readUInt32LE(end + 16), size = data.readUInt32LE(end + 12)
    if (!count || count > 1024 || count !== data.readUInt16LE(end + 8) || start + size !== end) return null
    let at = start, total = 0
    const entries: ZipEntry[] = [], names = new Set<string>()
    for (let index = 0; index < count; index++) {
      if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) return null
      const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), compressed = data.readUInt32LE(at + 20), expanded = data.readUInt32LE(at + 24)
      const nameSize = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32), local = data.readUInt32LE(at + 42)
      const name = strictText(data.subarray(at + 46, at + 46 + nameSize))
      total += expanded
      if (!name || name.length > 512 || name.includes("\\") || name.startsWith("/") || name.split("/").some(part => part === "." || part === "..") || /[\u0000-\u001f]/.test(name) || names.has(name) ||
          flags & 1 || ![0, 8].includes(method) || expanded > MAX_XML_BYTES || total > MAX_EXPANDED_BYTES || at + 46 + nameSize + extra + comment > end ||
          local + 30 > start || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method ||
          local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28) + compressed > start ||
          !data.subarray(local + 30, local + 30 + data.readUInt16LE(local + 26)).equals(data.subarray(at + 46, at + 46 + nameSize))) return null
      entries.push({ name, byteLength: expanded }); names.add(name)
      at += 46 + nameSize + extra + comment
    }
    return at === end ? entries : null
  } catch { return null }
}
async function boundedZipEntry(entry: JSZip.JSZipObject, expected: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer")
    const chunks: Uint8Array[] = []
    let size = 0, done = false
    stream.on("data", (chunk: Uint8Array) => {
      if (done) return
      size += chunk.length
      if (size > expected || size > MAX_XML_BYTES) { done = true; stream.pause(); reject(new Error("ZIP expansion bound")); return }
      chunks.push(chunk)
    }).on("error", reject).on("end", () => { if (!done) size === expected ? resolve(Buffer.concat(chunks)) : reject(new Error("ZIP length mismatch")) })
  })
}
export async function inspectDocxImages(bytes: Uint8Array): Promise<{ imageInspection: DocumentImageInspection; safeToExtract: boolean }> {
  const directory = boundedZipDirectory(bytes)
  if (!directory) return { imageInspection: "unknown", safeToExtract: false }
  try {
    const zip = await JSZip.loadAsync(bytes)
    const files = new Map<string, Uint8Array>()
    for (const item of directory) {
      const entry = zip.files[item.name]
      if (!entry) throw new Error("ZIP entry missing")
      files.set(item.name, await boundedZipEntry(entry, item.byteLength))
    }
    if (!files.has("[Content_Types].xml") || !files.has("word/document.xml") || !files.has("_rels/.rels")) return { imageInspection: "unknown", safeToExtract: true }
    let present = false, uncertain = false
    for (const [name, value] of files) {
      if (name.endsWith("/")) continue
      if (/\/media\//i.test(name)) present = true
      if (!/\.(?:xml|rels)$/i.test(name)) { if (!/\.(?:odttf|ttf|otf)$/i.test(name) && !/\/media\//i.test(name)) uncertain = true; continue }
      const text = strictText(value), document = text === null ? null : xmlDocument(text)
      if (!document) { uncertain = true; continue }
      for (const element of Array.from(document.getElementsByTagName("*"))) {
        const local = element.localName.toLowerCase()
        if (["blip", "imagedata", "image", "img", "bindata"].includes(local)) present = true
        if (local === "fldsimple" || local === "instrtext") {
          const instruction = local === "fldsimple" ? element.getAttribute("w:instr") ?? element.getAttribute("instr") ?? "" : element.textContent ?? ""
          if (/\bINCLUDEPICTURE\b/i.test(instruction)) present = true
          // Complex instructions may be split across multiple runs, or use a different field dialect.
          else uncertain = true
        }
        if (["drawing", "pict", "object", "oleobject", "altchunk", "svg", "include"].includes(local)) uncertain = true
        if (local === "default" || local === "override") {
          const type = element.getAttribute("ContentType") ?? ""
          if (/^image\//i.test(type)) present = true
          if (/html|oleObject|vmlDrawing/i.test(type)) uncertain = true
        }
        if (local === "relationship") {
          const type = element.getAttribute("Type") ?? "", external = element.getAttribute("TargetMode")?.toLowerCase() === "external"
          if (/\/image$/i.test(type)) present = true
          else if (/\/(?:aFChunk|oleObject|package|attachedTemplate)$/i.test(type) || (external && !/\/hyperlink$/i.test(type))) uncertain = true
        }
      }
    }
    return { imageInspection: present ? "present" : uncertain ? "unknown" : "none", safeToExtract: true }
  } catch { return { imageInspection: "unknown", safeToExtract: false } }
}

function pdfNames(value: string): string { return value.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) }
function pdfPartInspection(value: string): DocumentImageInspection {
  const text = pdfNames(value)
  if (/\/(?:Image|DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)\b|\bBI\b[\s\S]*?\bID\b/.test(text)) return "present"
  if (/\/(?:Encrypt|XFA|EmbeddedFile|RichMedia|JavaScript)\b/.test(text)) return "unknown"
  return "none"
}
export class UnsafePdfError extends Error {
  constructor() { super("PDF 结构损坏或超过安全解析预算，请精简或改用纯 TXT。") }
}
type PdfSafety = { imageInspection: DocumentImageInspection; safeToExtract: boolean }
/** Inspect every stream, even after finding an image. Unknown semantics and unsafe decoding are separate outcomes. */
export function inspectPdfSafety(bytes: Uint8Array): PdfSafety {
  const source = Buffer.from(bytes).toString("latin1")
  let result = pdfPartInspection(source)
  let at = 0, expanded = 0, streams = 0, pixels = 0
  const unsafe = (): PdfSafety => ({ imageInspection: result === "present" ? "present" : "unknown", safeToExtract: false })
  const inspectPart = (value: string): boolean => {
    const part = pdfNames(value), inspected = pdfPartInspection(part)
    if (inspected === "present") result = "present"
    else if (inspected === "unknown" && result !== "present") result = "unknown"
    const addPixels = (dictionary: string): boolean => {
      const width = [...dictionary.matchAll(/\/(?:Width|W)\s+(\d+)\b(?!\s+\d+\s+R)/g)], height = [...dictionary.matchAll(/\/(?:Height|H)\s+(\d+)\b(?!\s+\d+\s+R)/g)]
      if (width.length !== 1 || height.length !== 1) return false
      const count = Number(width[0][1]) * Number(height[0][1])
      pixels += count
      return Number.isSafeInteger(count) && count > 0 && pixels <= MAX_PDF_IMAGE_PIXELS
    }
    // Nested DecodeParms dictionaries are common; do not let them hide the enclosing image dimensions.
    const dictionaries: number[] = [], imageDictionaries = new Set<number>()
    for (const token of part.matchAll(/<<|>>|\/Subtype\s*\/Image\b/g)) {
      if (token[0] === "<<") dictionaries.push(token.index)
      else if (token[0] === ">>") {
        const start = dictionaries.pop()
        if (start !== undefined && imageDictionaries.delete(start) && !addPixels(part.slice(start, token.index + 2))) return false
      } else {
        const start = dictionaries.at(-1)
        if (start === undefined) return false
        imageDictionaries.add(start)
      }
    }
    if (imageDictionaries.size) return false
    for (const match of part.matchAll(/\bBI\b[\s\S]*?\bID\b/g)) if (!addPixels(match[0])) return false
    return true
  }
  let previous = 0
  const streamPattern = /\bstream\b(?:\r\n|\r|\n)?/g
  while (true) {
    streamPattern.lastIndex = at
    const match = streamPattern.exec(source)
    if (!match) break
    if (++streams > 1024 || match[0] === "stream") return unsafe()
    if (!inspectPart(source.slice(previous, match.index))) return unsafe()
    const dictionary = pdfNames(source.slice(Math.max(0, source.lastIndexOf("obj", match.index)), match.index))
    const lengths = [...dictionary.matchAll(/\/Length\s+(\d+)(?:\s+(\d+)\s+R\b)?/g)]
    if (lengths.length !== 1) return unsafe()
    let length = Number(lengths[0][1])
    if (lengths[0][2] !== undefined) {
      const references = [...source.matchAll(new RegExp(`(?:^|[\\r\\n])${lengths[0][1]}\\s+${lengths[0][2]}\\s+obj\\s+(\\d+)\\s+endobj`, "g"))]
      if (references.length !== 1) return unsafe()
      length = Number(references[0][1])
    }
    const start = match.index + match[0].length, end = start + length
    if (!Number.isSafeInteger(length) || length < 0 || end > bytes.length || !/^\s*endstream\b/.test(source.slice(end, end + 32))) return unsafe()
    const filters = [...dictionary.matchAll(/\/Filter\s*(\/\w+|\[[^\]]*\])/g)]
    let content = bytes.subarray(start, end), inspectContent = true
    if (/\/Filter\b/.test(dictionary) && !filters.length) return unsafe()
    if (filters.length) {
      if (filters.length !== 1) return unsafe()
      const filter = filters[0][1].replace(/^\[\s*|\s*\]$/g, "").trim()
      if (/^\/(?:FlateDecode|Fl)$/.test(filter)) {
        if (expanded >= MAX_EXPANDED_BYTES) return unsafe()
        try { content = inflateSync(content, { maxOutputLength: MAX_EXPANDED_BYTES - expanded }) }
        catch { return unsafe() }
      } else if (/^\/(?:ASCIIHexDecode|AHx)$/.test(filter)) {
        const hex = Buffer.from(content).toString("latin1").replace(/\s/g, "").replace(/>$/, "")
        if (!/^[\da-f]*$/i.test(hex)) return unsafe()
        content = Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex")
      } else if (/^\/(?:DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)$/.test(filter) && /\/Subtype\s*\/Image\b/.test(dictionary)) {
        inspectContent = false // Raster expansion is bounded by the total image pixel budget.
      } else return unsafe()
    }
    expanded += content.length
    if (expanded > MAX_EXPANDED_BYTES || (inspectContent && !inspectPart(Buffer.from(content).toString("latin1")))) return unsafe()
    if (/\/DecodeParms\b/.test(dictionary) && result !== "present") result = "unknown"
    at = end + source.slice(end).indexOf("endstream") + "endstream".length
    previous = at
  }
  if (!inspectPart(source.slice(previous))) return unsafe()
  return { imageInspection: result, safeToExtract: true }
}
export function inspectPdfStructure(bytes: Uint8Array): DocumentImageInspection {
  const inspected = inspectPdfSafety(bytes)
  return inspected.safeToExtract ? inspected.imageInspection : "unknown"
}

export const PDF_MEMORY_OPTIONS = { useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWasm: false, maxImageSize: MAX_PDF_IMAGE_PIXELS, verbosity: 0 } as const
type PdfModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs")
export type InspectedPdfPage = { page: PDFPageProxy; operators: Awaited<ReturnType<PDFPageProxy["getOperatorList"]>> | null; pdf: PdfModule; checkBudget: () => void }
/** One loading task, deadline and resource budget cover inspection and extraction. */
export async function inspectPdfImages(bytes: Uint8Array, visitPage?: (value: InspectedPdfPage) => Promise<void>): Promise<DocumentImageInspection> {
  const deadline = performance.now() + PDF_TIMEOUT_MS
  let stopped = false
  const checkBudget = () => { if (stopped || performance.now() >= deadline) throw new UnsafePdfError() }
  const structure = inspectPdfSafety(bytes)
  if (!structure.safeToExtract) throw new UnsafePdfError()
  checkBudget()
  // 显式入口使独立制品追踪 PDF.js 在 Node 中动态加载的原生图形依赖。
  await import("@napi-rs/canvas")
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs")
  checkBudget()
  const task = pdf.getDocument({ ...PDF_MEMORY_OPTIONS, data: new Uint8Array(bytes), stopAtErrors: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  let destruction: Promise<void> | undefined, timedOut = false
  const destroy = () => destruction ??= task.destroy().catch(() => {})
  try {
    const inspect = async (): Promise<DocumentImageInspection> => {
      const document = await task.promise
      checkBudget()
      if (document.numPages > MAX_DOCUMENT_PAGES) throw new UnsafePdfError()
      const imageOps = new Set(Object.entries(pdf.OPS).filter(([name]) => /Image/.test(name)).map(([, code]) => code))
      const uncertainOps = new Set([pdf.OPS.constructPath, pdf.OPS.shadingFill, pdf.OPS.paintFormXObjectBegin, pdf.OPS.paintXObject])
      let total = 0
      let result: DocumentImageInspection = document.isPureXfa && structure.imageInspection !== "present" ? "unknown" : structure.imageInspection
      for (let index = 1; index <= document.numPages; index++) {
        checkBudget()
        const page = await document.getPage(index)
        checkBudget()
        try {
          let operators: InspectedPdfPage["operators"] = null
          try { operators = await page.getOperatorList({ annotationMode: pdf.AnnotationMode.ENABLE }) }
          catch { if (result !== "present") result = "unknown" }
          checkBudget()
          if (operators) {
            total += operators.fnArray.length
            if (total > MAX_PDF_OPERATORS) throw new UnsafePdfError()
            if (operators.fnArray.some(code => imageOps.has(code))) result = "present"
            else if (result !== "present" && operators.fnArray.some(code => uncertainOps.has(code))) result = "unknown"
          }
          if (visitPage) await visitPage({ page, operators, pdf, checkBudget })
          checkBudget()
        } finally { page.cleanup() }
      }
      return result
    }
    return await Promise.race([inspect(), new Promise<never>((_, reject) => { timeout = setTimeout(() => { stopped = true; timedOut = true; void destroy(); reject(new UnsafePdfError()) }, Math.max(1, deadline - performance.now())) })])
  } catch (error) {
    if (visitPage || error instanceof UnsafePdfError) throw error
    return "unknown"
  } finally {
    stopped = true
    if (timeout) clearTimeout(timeout)
    if (timedOut) void destroy()
    else await destroy()
  }
}
