import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { AccountError } from "../lib/auth/errors"
import { assertPrivateReferenceSource, parsePrivateGenerationForm, readPrivateGenerationForm } from "../lib/private-generation-input"

const creationId = randomUUID(), requestId = randomUUID()
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C3QAAAAASUVORK5CYII=", "base64")
function form() {
  const data = new FormData()
  for (const [key, value] of Object.entries({ creationId, clientRequestId: requestId, mappingId: "mapping", configRevision: "1", prompt: "把背景改成蓝色", aspectRatio: "square", quality: "auto", mode: "text-to-image" })) data.set(key, value)
  return data
}
const invalid = (error: unknown) => error instanceof AccountError && error.status === 400

test("私有请求仅接受白名单单值；用户、模型、秘密、对象键和旧版本号不能覆盖服务端", async () => {
  for (const key of ["ownerId", "userId", "baseUrl", "apiKey", "apiMode", "modelId", "selectedModel", "outputKey", "version", "clientVersionId", "baseImageUrl"]) {
    const data = form(); data.set(key, "forbidden")
    await assert.rejects(parsePrivateGenerationForm(data), invalid)
  }
  const duplicate = form(); duplicate.append("mappingId", "other")
  await assert.rejects(parsePrivateGenerationForm(duplicate), invalid)
})

test("指纹绑定原始提示、版本、映射修订与输入内容，同输入稳定且不保存URL", async () => {
  const original = await parsePrivateGenerationForm(form())
  assert.equal((await parsePrivateGenerationForm(form())).command.fingerprint, original.command.fingerprint)
  for (const [key, value] of [["prompt", "不同要求"], ["configRevision", "2"], ["mappingId", "other"], ["quality", "high"], ["creationId", randomUUID()]]) {
    const data = form(); data.set(key, value)
    assert.notEqual((await parsePrivateGenerationForm(data)).command.fingerprint, original.command.fingerprint)
  }
  const data = form(); data.set("image1Url", "https://public.example/photo.png?synthetic=token")
  const image = await parsePrivateGenerationForm(data)
  assert.equal(image.command.mode, "image-editing")
  assert.doesNotMatch(JSON.stringify(image.command), /public\.example|synthetic=token/)
  const withParent = form(); withParent.set("parentVersionId", randomUUID()); withParent.set("mode", "image-editing")
  assert.notEqual((await parsePrivateGenerationForm(withParent)).command.fingerprint, original.command.fingerprint)
})

test("文档原文只拼接一次；文件和恢复文本互斥，文档内容参与指纹", async () => {
  const data = form(); data.set("document", new File(["独一份文档内容"], "说明.txt", { type: "text/plain" }))
  const input = await parsePrivateGenerationForm(data)
  assert.equal(input.command.prompt, "把背景改成蓝色")
  assert.equal(input.effectivePrompt.split("独一份文档内容").length - 1, 1)
  const changed = form(); changed.set("document", new File(["不同文档内容"], "说明.txt", { type: "text/plain" }))
  assert.notEqual((await parsePrivateGenerationForm(changed)).command.fingerprint, input.command.fingerprint)
  data.set("documentText", "重复文字")
  await assert.rejects(parsePrivateGenerationForm(data), invalid)
  const restored = form(); restored.set("documentName", "恢复原稿.pdf"); restored.set("documentText", "恢复文字")
  const result = await parsePrivateGenerationForm(restored)
  assert.equal(result.document?.mediaType, "text/plain")
  assert.equal(Buffer.from(result.document!.bytes).toString(), "恢复文字")
  const oversized = form(); oversized.set("documentName", "说明.txt"); oversized.set("documentText", "文".repeat(4999))
  await assert.rejects(parsePrivateGenerationForm(oversized), invalid)
})

test("错误基准、编辑无图、多余图片和混用输入必须失败，不能降级文本生成", async () => {
  const badBase = form(); badBase.set("parentVersionId", requestId)
  await assert.rejects(parsePrivateGenerationForm(badBase), invalid)
  const noImage = form(); noImage.set("mode", "image-editing")
  await assert.rejects(parsePrivateGenerationForm(noImage), invalid)
  const tooMany = form(); tooMany.set("parentVersionId", randomUUID()); tooMany.set("mode", "image-editing")
  for (const key of ["image1", "image2"]) tooMany.set(key, new File([png], "reference.png", { type: "image/png" }))
  await assert.rejects(parsePrivateGenerationForm(tooMany), invalid)
  const mixed = form(); mixed.set("image1", new File([png], "reference.png")); mixed.set("image1Url", "https://public.example/image.png")
  await assert.rejects(parsePrivateGenerationForm(mixed), invalid)
})

test("本应用绝对路径、旧能力与私有桶/CDN引用不能走公网回退", () => {
  const env = { NODE_ENV: "test" as const, BETTER_AUTH_URL: "https://app.example", COS_DOMAIN: "https://cdn.example", COS_BUCKET: "private-bucket-123", COS_REGION: "ap-shanghai" }
  const assetId = randomUUID()
  assert.doesNotThrow(() => assertPrivateReferenceSource(`/api/images/${assetId}`, env))
  assert.doesNotThrow(() => assertPrivateReferenceSource("https://public.example/image.png", env))
  for (const source of [
    `/api/assets/old?access=old`, `https://app.example/api/images/${assetId}`, `https://cdn.example/anything.png`,
    "https://private-bucket-123.cos.ap-shanghai.myqcloud.com/anything.png", "https://other.example/api/assets/old?access=old",
    "https://other.example/image-playground/private/v1/key", "https://other.example/image-playground/runs/key",
    `https://other.example/%61pi/images/${assetId}`, "https://username:password@public.example/image.png",
  ]) assert.throws(() => assertPrivateReferenceSource(source, env), invalid, source)
})

test("multipart读取校验实际大小和Content-Type，不信任虚报的Content-Length", async () => {
  const request = new Request("http://localhost/api/generate-image", { method: "POST", body: form() })
  const parsed = await parsePrivateGenerationForm(await readPrivateGenerationForm(request))
  assert.equal(parsed.command.clientRequestId, requestId)
  await assert.rejects(readPrivateGenerationForm(new Request("http://localhost", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })), invalid)
  const chunk = new Uint8Array(1024 * 1024)
  let emitted = 0, cancelled = false
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { emitted++; controller.enqueue(chunk) }, cancel() { cancelled = true } })
  const oversized = new Request("http://localhost", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test", "content-length": "1" }, body: stream, duplex: "half" } as RequestInit)
  await assert.rejects(readPrivateGenerationForm(oversized), invalid)
  assert.equal(cancelled, true)
  assert.ok(emitted <= 34)
})

test("停发multipart和永不完成的cancel不能绕过上传时限", async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) }, cancel() { cancelled = true; return new Promise(() => {}) } })
  const request = new Request("http://localhost", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" }, body: stream, duplex: "half" } as RequestInit)
  await assert.rejects(readPrivateGenerationForm(request, 10), error => error instanceof AccountError && error.code === "REQUEST_BODY_TIMEOUT" && error.status === 408)
  assert.equal(cancelled, true)
})

function annotatedForm() {
  const data = form(), parentVersionId = randomUUID()
  const snapshot = { schema: 1, coordinateSpace: "encoded-pixels-v1", baseVersionId: parentVersionId,
    image: { assetId: randomUUID(), width: 80, height: 60, orientation: 1, pages: 1 },
    marks: [{ id: randomUUID(), number: 4, instruction: "将此区域改成蓝色", geometry: { type: "rectangle", x: 10, y: 12, width: 30, height: 20 } }],
  }
  data.set("parentVersionId", parentVersionId); data.set("mode", "image-editing"); data.set("prompt", "")
  data.set("annotationSnapshot", JSON.stringify(snapshot))
  return { data, snapshot }
}

test("批注允许空整体要求，编号与区域进入请求指纹且纯文字文档可组合", async () => {
  const { data, snapshot } = annotatedForm()
  const first = await parsePrivateGenerationForm(data)
  assert.equal(first.command.prompt, "")
  assert.deepEqual(first.command.annotationSnapshot, snapshot)
  assert.match(first.effectivePrompt, /将此区域改成蓝色/)
  assert.equal((await parsePrivateGenerationForm(data)).command.fingerprint, first.command.fingerprint)
  snapshot.marks[0].geometry.x += 1
  data.set("annotationSnapshot", JSON.stringify(snapshot))
  assert.notEqual((await parsePrivateGenerationForm(data)).command.fingerprint, first.command.fingerprint)
  data.set("document", new File(["保留其余画面"], "brief.txt", { type: "text/plain" }))
  const withDocument = await parsePrivateGenerationForm(data)
  assert.equal(withDocument.document?.imageInspection, "none")
  assert.match(withDocument.effectivePrompt, /保留其余画面/)
})

test("批注拒绝额外参考图、错误基准、伪造字段、非法几何及超限组合", async () => {
  for (const change of [
    (data: FormData) => data.set("image1Url", "https://public.example/reference.png"),
    (data: FormData) => data.set("image1", new File([png], "reference.png", { type: "image/png" })),
    (data: FormData) => data.delete("parentVersionId"),
    (data: FormData) => data.set("parentVersionId", randomUUID()),
    (data: FormData) => data.set("annotationSnapshot", "null"),
    (data: FormData) => data.set("prompt", "字".repeat(5000)),
  ]) {
    const { data } = annotatedForm(); change(data)
    await assert.rejects(parsePrivateGenerationForm(data), invalid)
  }
  for (const change of [
    (snapshot: ReturnType<typeof annotatedForm>["snapshot"]) => { snapshot.marks[0].instruction = "" },
    (snapshot: ReturnType<typeof annotatedForm>["snapshot"]) => { snapshot.marks[0].geometry.width = 100 },
    (snapshot: ReturnType<typeof annotatedForm>["snapshot"]) => { Object.assign(snapshot, { ownerId: randomUUID() }) },
  ]) {
    const { data, snapshot } = annotatedForm(); change(snapshot); data.set("annotationSnapshot", JSON.stringify(snapshot))
    await assert.rejects(parsePrivateGenerationForm(data), invalid)
  }
})

test("无批注请求继续使用原有字段顺序和指纹，不引入null字段破坏旧请求重试", async () => {
  const { bytesHash } = await import("../lib/private-generation-input")
  const parsed = await parsePrivateGenerationForm(form())
  assert.equal(Object.hasOwn(parsed.command, "annotationSnapshot"), false)
  assert.equal(parsed.command.fingerprint, bytesHash(JSON.stringify({ creationId, clientRequestId: requestId, fingerprint: "", parentVersionId: null, mappingId: "mapping", configRevision: 1, prompt: "把背景改成蓝色", aspectRatio: "square", quality: "auto", mode: "text-to-image", references: [], document: null })))
})
