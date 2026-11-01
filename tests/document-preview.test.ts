import assert from "node:assert/strict"
import { test } from "node:test"
import type { AccountIdentity } from "../lib/auth/guards"
import { AccountError } from "../lib/auth/errors"
import { documentPreviewResponse, readDocumentPreviewForm } from "../lib/document-preview"
import { parseDocument } from "../lib/document-parser"

const identity: AccountIdentity = { user: { id: "preview-user", username: "preview-user", name: "Preview", role: "user", mustChangePassword: false }, sessionId: "synthetic-session", sessionToken: "synthetic-token" }
function form() { const value = new FormData(); value.set("document", new File(["预览文字"], "brief.txt", { type: "text/plain" })); return value }
function request(body = form()) { return new Request("https://preview.test/api/documents/preview", { method: "POST", body, headers: { origin: "https://preview.test" } }) }
function fixture() {
  const calls = { origin: 0, authorize: 0, parse: 0 }
  return { calls, dependencies: {
    assertOrigin: () => { calls.origin++ },
    authorize: async () => { calls.authorize++; return identity },
    parse: async (file: File) => { calls.parse++; return parseDocument(file) },
  } }
}

test("文档预览仅返回安全文字与检查结论，解析前后鉴权且no-store", async () => {
  const f = fixture(), response = await documentPreviewResponse(request(), f.dependencies)
  assert.equal(response.status, 200)
  assert.match(response.headers.get("cache-control")!, /private.*no-store/)
  assert.equal(response.headers.get("vary"), "Cookie")
  assert.deepEqual(await response.json(), { document: { name: "brief.txt", text: "预览文字", imageInspection: "none" } })
  assert.deepEqual(f.calls, { origin: 1, authorize: 2, parse: 1 })
})

test("预览拒绝伪造预检状态/恢复文字/重复字段，鉴权失败或解析后撤销不交付结果", async () => {
  for (const key of ["imageInspection", "documentText", "documentName", "ownerId", "image1Url"]) {
    const f = fixture(), data = form(); data.set(key, "none")
    assert.equal((await documentPreviewResponse(request(data), f.dependencies)).status, 400)
    assert.equal(f.calls.parse, 0)
  }
  const duplicate = form(); duplicate.append("document", new File(["second"], "second.txt"))
  assert.equal((await documentPreviewResponse(request(duplicate), fixture().dependencies)).status, 400)
  const text = new FormData(); text.set("document", "fake file")
  assert.equal((await documentPreviewResponse(request(text), fixture().dependencies)).status, 400)
  const revoked = fixture()
  revoked.dependencies.authorize = async () => { if (++revoked.calls.authorize === 2) throw new AccountError("UNAUTHENTICATED", 401, "请重新登录。"); return identity }
  const denied = await documentPreviewResponse(request(), revoked.dependencies)
  assert.equal(denied.status, 401); assert.equal(Object.hasOwn(await denied.json(), "document"), false)
  const origin = fixture(); origin.dependencies.assertOrigin = () => { throw new AccountError("FORBIDDEN", 403, "来源不受信任") }
  assert.equal((await documentPreviewResponse(request(), origin.dependencies)).status, 403)
  assert.equal(origin.calls.authorize + origin.calls.parse, 0)
})

test("预览按实际字节限流并处理停发，不信任Content-Length或无限cancel", async () => {
  let cancelled = false
  const oversized = new Request("https://preview.test", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test", "content-length": "1" }, duplex: "half", body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } }) } as RequestInit)
  await assert.rejects(readDocumentPreviewForm(oversized), error => error instanceof AccountError && error.status === 400)
  assert.equal(cancelled, true)
  const stalled = new Request("https://preview.test", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" }, duplex: "half", body: new ReadableStream({ pull() { return new Promise(() => {}) }, cancel() { return new Promise(() => {}) } }) } as RequestInit)
  await assert.rejects(readDocumentPreviewForm(stalled, 10), error => error instanceof AccountError && error.status === 408)
})
