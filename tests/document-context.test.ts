import { strict as assert } from "node:assert"
import { test } from "node:test"
// @ts-expect-error Node's built-in TypeScript runner requires the file extension.
import { composePrompt, isDocumentFile, validateDocumentFile } from "../lib/document-context.ts"

test("document validation accepts text, PDF and Word files", () => {
  for (const file of [
    new File(["第一行\r\n第二行"], "brief.md", { type: "text/markdown" }),
    new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" }),
    new File(["PK"], "brief.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
  ]) {
    assert.equal(isDocumentFile(file), true)
    assert.doesNotThrow(() => validateDocumentFile(file))
  }
})

test("unsupported files and files larger than 10 MB are rejected", () => {
  assert.throws(() => validateDocumentFile(new File(["binary"], "brief.exe", { type: "application/octet-stream" })), /支持 TXT、MD、CSV、JSON、HTML、XML、PDF 和 DOCX/)
  assert.throws(() => validateDocumentFile(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "brief.pdf", { type: "application/pdf" })), /不能超过 10 MB/)
})

test("prompt context keeps the document delimiters explicit", () => {
  assert.equal(composePrompt("制作海报", "brief.txt", "地点：佛山"), "制作海报\n\n【文档上下文：brief.txt】\n地点：佛山\n【文档上下文结束】")
})
