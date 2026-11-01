import assert from "node:assert/strict"
import { test } from "node:test"
import { deflateSync } from "node:zlib"
import JSZip from "jszip"
import { syntheticPdf as pdf, syntheticDocx as docx } from "./support/synthetic-documents.mjs"
import { parseDocument } from "../lib/document-parser"
import { inspectDocxImages, inspectPdfImages, inspectPdfSafety, inspectPdfStructure, inspectTextDocument, UnsafePdfError } from "../lib/document-image-inspection"


test("TXT/纯文字标记可靠none；HTML/Markdown/XML图像或未确认内容不伪称无图", async t => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("文档图像引用不得发起外部请求") })
  assert.equal((await parseDocument(new File(["第一行\r\n第二行"], "brief.txt"))).imageInspection, "none")
  for (const [name, body, expected] of [["brief.md", "# 纯文字\n说明", "none"], ["brief.md", "![示意](https://invalid.test/a.png)", "present"], ["brief.html", "<html><body><p>纯文字</p></body></html>", "none"], ["brief.html", '<input type="image" src="x">', "present"], ["brief.html", '<p style="background: u\\72l(x)">背景</p>', "unknown"], ["brief.xml", '<root><image href="x"/></root>', "present"], ["brief.xml", '<custom>无法证明渲染方式</custom>', "unknown"]] as const) {
    assert.equal((await parseDocument(new File([body], name))).imageInspection, expected, name)
  }
  assert.equal(inspectTextDocument(new Uint8Array([255, 254, 60, 0]), "txt"), "unknown")
  assert.equal((await parseDocument(new File(['<html><body background="https://example.invalid/picture.png">正文</body></html>'], "background.html"))).imageInspection, "present")
})

test("纯文字PDF全页检查为none；1px小图即使未提取也为present", async () => {
  for (const options of [{}, { encoding: "flate" as const }, { encoding: "flate" as const, indirectLength: true }]) {
    const parsed = await parseDocument(new File([pdf(options)], "text.pdf", { type: "application/pdf" }))
    assert.match(parsed.text, /Hello document/)
    assert.equal(parsed.imageInspection, "none")
  }
  for (const escapedImageName of [false, true]) {
    const parsed = await parseDocument(new File([pdf({ image: true, escapedImageName })], "small.pdf", { type: "application/pdf" }))
    assert.match(parsed.text, /Hello document/)
    assert.equal(parsed.images.length, 0)
    assert.equal(parsed.imageInspection, "present")
  }
})

test("PDF未知矢量保留文字，损坏图片明确失败，完整有界ASCIIHex文字可确认none", async () => {
  await assert.rejects(parseDocument(new File([pdf({ image: true, badImage: true })], "broken-image.pdf")), /无法安全读取/)
  const vector = await parseDocument(new File([pdf({ vector: true })], "unconfirmed.pdf"))
  assert.match(vector.text, /Hello document/); assert.equal(vector.imageInspection, "unknown")
  assert.equal((await parseDocument(new File([pdf({ encoding: "hex" })], "hex.pdf"))).imageInspection, "none")
  assert.equal(await inspectPdfImages(Buffer.from("%PDF-1.7\nnot a complete PDF")), "unknown")
  const compressed = deflateSync(Buffer.from("9 0 obj << /Subtype /Image /Width 999999 /Height 999999 >> endobj"))
  const hidden = Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj << /Type /ObjStm /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`), compressed, Buffer.from("\nendstream\nendobj")])
  assert.deepEqual(inspectPdfSafety(hidden), { imageInspection: "present", safeToExtract: false })
  assert.equal(inspectPdfStructure(Buffer.from("%PDF-1.7\n1 0 obj << /Length 999999 >>\nstream\nx\nendstream")), "unknown")
})

test("纯文字DOCX可靠none，正文小图、页眉、外部关系和不支持格式都识别存在", async t => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("DOCX图片域和关系不得发起外部请求") })
  const plain = await parseDocument(new File([new Uint8Array(await docx())], "text.docx"))
  assert.equal(plain.imageInspection, "none"); assert.match(plain.text, /Hello Word/)
  for (const options of [{ image: true }, { image: true, header: true }, { image: true, external: true }, { image: true, unsupported: true }]) {
    const parsed = await parseDocument(new File([new Uint8Array(await docx(options))], "image.docx"))
    assert.equal(parsed.imageInspection, "present"); assert.match(parsed.text, /Hello Word/)
    if (options.header || options.external || options.unsupported) assert.equal(parsed.images.length, 0)
    else assert.equal(parsed.images.length, 1)
  }
  const malformed = await parseDocument(new File([new Uint8Array(await docx({ malformedHeader: true }))], "unconfirmed.docx"))
  assert.equal(malformed.imageInspection, "unknown"); assert.match(malformed.text, /Hello Word/)
  for (const pictureField of ["simple", "complex", "split"] as const) {
    const parsed = await parseDocument(new File([new Uint8Array(await docx({ pictureField }))], "picture-field.docx"))
    assert.match(parsed.text, /Hello Word/)
    assert.equal(parsed.imageInspection, pictureField === "split" ? "unknown" : "present")
  }
})

test("DOCX声明膨胀/缺失包结构/坏压缩不绕过预检，PDF/ZIP改TXT后缀不获none", async () => {
  const original = await docx(), excessive = Buffer.from(original)
  const central = excessive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  excessive.writeUInt32LE(50 * 1024 * 1024, central + 24)
  assert.deepEqual(await inspectDocxImages(excessive), { imageInspection: "unknown", safeToExtract: false })
  const incomplete = new JSZip(); incomplete.file("word/document.xml", "<document>text</document>")
  assert.equal((await inspectDocxImages(await incomplete.generateAsync({ type: "nodebuffer" }))).imageInspection, "unknown")
  await assert.rejects(parseDocument(new File([new Uint8Array(original)], "disguised.txt")), /类型不一致/)
  await assert.rejects(parseDocument(new File([pdf()], "disguised.txt")), /类型不一致/)
  await assert.rejects(parseDocument(new File(["text"], "bad\nname.txt")), /名称无效/)
})

test("PDF非标准流边界与压缩内联巨图不因解码器跳过而误报none", () => {
  const inline = deflateSync(Buffer.from("BI\0/W 999999 /H 999999 /CS /RGB /BPC 8 ID\0x EI", "latin1"))
  const stream = (spacing: string) => Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj << /Filter /FlateDecode /Length ${inline.length} >>\nstream${spacing}`), inline, Buffer.from("\nendstream\nendobj")])
  assert.deepEqual(inspectPdfSafety(stream("\n")), { imageInspection: "present", safeToExtract: false })
  assert.equal(inspectPdfStructure(stream(" \n")), "unknown")
})

test("PDF解压/总像素/页数预算失败不进入文字或图片提取，已发现小图也不能绕过后续流预算", async () => {
  const documents = [pdf({ encoding: "flate", paddingBytes: 33 * 1024 * 1024 }), pdf({ encoding: "flate", paddingBytes: 33 * 1024 * 1024, image: true }), pdf({ image: true, imageSize: 3000 }), pdf({ image: true, imageSize: 1700, imageCount: 3 }), pdf({ pages: 201 })]
  for (const bytes of documents) {
    let visits = 0
    await assert.rejects(inspectPdfImages(bytes, async () => { visits++ }), UnsafePdfError)
    assert.equal(visits, 0)
    await assert.rejects(parseDocument(new File([bytes], "over-budget.pdf")), /安全解析预算/)
  }
})

test("PDF同一解析任务共用期限，操作检查超时后不再启动提取", async t => {
  await import("@napi-rs/canvas")
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const task = getDocument({ data: new Uint8Array(pdf()), useSystemFonts: false, verbosity: 0 })
  const document = await task.promise, prototype = Object.getPrototypeOf(await document.getPage(1))
  await task.destroy()
  let now = 0, visits = 0
  t.mock.method(performance, "now", () => now)
  const original = prototype.getOperatorList
  t.mock.method(prototype, "getOperatorList", async function (this: unknown, ...args: unknown[]) { const result = await original.apply(this, args); now += 5001; return result })
  await assert.rejects(inspectPdfImages(pdf(), async () => { visits++ }), UnsafePdfError)
  assert.equal(visits, 0)
  now = 0
  await assert.rejects(parseDocument(new File([pdf()], "timed-out.pdf")), /安全解析预算/)
})

test("正常多图PDF保留原文且只编码前两图；正文超限及时拒绝", async t => {
  const canvas = await import("@napi-rs/canvas")
  const prototype = Object.getPrototypeOf(canvas.createCanvas(1, 1)), encode = prototype.encode
  let encoded = 0
  t.mock.method(prototype, "encode", function (this: unknown, ...args: unknown[]) { encoded++; return encode.apply(this, args) })
  const parsed = await parseDocument(new File([pdf({ image: true, imageSize: 65, imageCount: 3, pages: 3 })], "images.pdf"))
  assert.equal(parsed.imageInspection, "present")
  assert.equal(parsed.text.match(/Hello document/g)?.length, 3)
  assert.equal(parsed.images.length, 2); assert.equal(encoded, 2)
  assert.ok(parsed.images.every(image => image.mediaType === "image/png"))
  await assert.rejects(parseDocument(new File([pdf({ text: "a".repeat(12_001) })], "too-long.pdf")), /12000/)
})


test("HTML属性名不区分大小写，背景、样式和图片属性不得误判无图", () => {
  for (const [attribute, expected] of [["BACKGROUND", "present"], ["bAcKgRoUnD", "present"], ["STYLE", "unknown"], ["PoStEr", "present"], ["SRCSET", "present"]] as const) {
    const bytes = Buffer.from(`<body ${attribute}="https://example.invalid/image.png">text</body>`)
    assert.equal(inspectTextDocument(bytes, "html"), expected)
  }
  assert.equal(inspectTextDocument(Buffer.from('<INPUT TYPE="IMAGE" SRC="image.png">'), "html"), "present")
})
