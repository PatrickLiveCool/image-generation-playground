import { deflateSync } from "node:zlib"
import JSZip from "jszip"

// Shared synthetic fixtures for unit and built HTTP acceptance; every byte stays in memory.
/** @param {{ image?: boolean, badImage?: boolean, vector?: boolean, encoding?: "flate" | "hex", escapedImageName?: boolean, indirectLength?: boolean, pages?: number, imageCount?: number, imageSize?: number, paddingBytes?: number, text?: string }} [options] */
export function syntheticPdf(options = {}) {
  const imageCount = options.image ? options.imageCount ?? 1 : 0, size = options.imageSize ?? 1
  const text = `BT /F1 12 Tf 10 100 Td (${options.text ?? "Hello document"}) Tj ET\n` + Array.from({ length: imageCount }, (_, i) => `q 1 0 0 1 20 20 cm /Im${i} Do Q\n`).join("") + (options.vector ? "0 0 20 20 re f\n" : "") + " ".repeat(options.paddingBytes ?? 0)
  let content = Buffer.from(text), filter = ""
  if (options.encoding === "flate") { content = deflateSync(content); filter = "/Filter /FlateDecode " }
  if (options.encoding === "hex") { content = Buffer.from(content.toString("hex") + ">"); filter = "/Filter /ASCIIHexDecode " }
  const pages = options.pages ?? 1
  /** @type {Buffer[]} */
  const objects = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.alloc(0), Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")]
  /** @param {Buffer} object */
  const add = object => { objects.push(object); return objects.length }
  const lengthId = options.indirectLength ? add(Buffer.from(String(content.length))) : 0
  /** @param {string} dictionary @param {Buffer} bytes @param {number} [indirect] */
  const stream = (dictionary, bytes, indirect = 0) => Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${indirect ? `${indirect} 0 R` : bytes.length} >>\nstream\n`), bytes, Buffer.from("\nendstream")])
  const contentId = add(stream(filter, content, lengthId)), imageIds = []
  for (let i = 0; i < imageCount; i++) {
    const raw = options.badImage ? Buffer.from([255, 0, 0]) : deflateSync(Buffer.alloc(size * size * 3, 80 + i))
    imageIds.push(add(stream(`/Type /XObject /Subtype /${options.escapedImageName ? "I#6dage" : "Image"} /Width ${size} /Height ${size} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${options.badImage ? "DCTDecode" : "FlateDecode"}`, raw)))
  }
  const pageIds = []
  for (let i = 0; i < pages; i++) pageIds.push(add(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Math.max(200, (options.text?.length ?? 0) * 12)} 200] /Resources << /Font << /F1 3 0 R >> ${imageIds.length ? `/XObject << ${imageIds.map((id, image) => `/Im${image} ${id} 0 R`).join(" ")} >>` : ""} >> /Contents ${contentId} 0 R >>`)))
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages} >>`)
  const parts = [Buffer.from("%PDF-1.7\n")], offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.concat(parts).length); parts.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")) }
  const xref = Buffer.concat(parts).length
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`))
  return Buffer.concat(parts)
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64")
/** @param {{ image?: boolean, header?: boolean, external?: boolean, unsupported?: boolean, malformedHeader?: boolean, pictureField?: "simple" | "complex" | "split" }} [options] */
export async function syntheticDocx(options = {}) {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${options.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}</Types>`)
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  const picture = '<w:p><w:r><w:pict><v:imagedata r:id="rIdImage"/></w:pict></w:r></w:p>'
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"'
  const field = options.pictureField === "simple" ? '<w:p><w:fldSimple w:instr=" INCLUDEPICTURE &quot;https://must-not-fetch.invalid/image.png&quot; "><w:r><w:t>Picture field</w:t></w:r></w:fldSimple></w:p>' : options.pictureField ? `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>${options.pictureField === "split" ? 'INCLUDE</w:instrText></w:r><w:r><w:instrText>PICTURE' : 'INCLUDEPICTURE'} &quot;https://must-not-fetch.invalid/image.png&quot;</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` : ""
  zip.file("word/document.xml", `<w:document ${ns}><w:body><w:p><w:r><w:t>Hello Word</w:t></w:r></w:p>${field}${options.image && !options.header ? picture : ""}${options.header ? '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/></w:sectPr>' : ""}</w:body></w:document>`)
  if (options.header) zip.file("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>')
  if (options.image) {
    const target = options.external ? "https://must-not-fetch.invalid/private.png" : options.unsupported ? "media/small.wmf" : "media/small.png"
    const relationships = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}" ${options.external ? 'TargetMode="External"' : ""}/></Relationships>`
    zip.file(`word/_rels/${options.header ? "header1" : "document"}.xml.rels`, relationships)
    if (options.header) zip.file("word/header1.xml", `<w:hdr ${ns}>${picture}</w:hdr>`)
    if (!options.external) zip.file("word/" + target, options.unsupported ? Buffer.from("unsupported-wmf") : png)
  }
  if (options.malformedHeader) zip.file("word/header1.xml", "<w:hdr><broken>")
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

