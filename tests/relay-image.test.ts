import { strict as assert } from "node:assert"
import { test, after } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import ts from "typescript"

// Compile these server helpers in isolation so Node can test their real code
// without loading Next.js or relying on its path-resolution hooks.
const dir = mkdtempSync(path.join(tmpdir(), "relay-contract-"))
for (const name of ["provider-network", "relay-image"]) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8")
  writeFileSync(path.join(dir, `${name}.js`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
}
const require = createRequire(import.meta.url)
const { generateRelayImage, extractImageSource, readImageSource, imageBytes } = require(path.join(dir, "relay-image.js"))
after(() => rmSync(dir, { recursive: true, force: true }))
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="
const image = imageBytes(Buffer.from(png, "base64"))
const settings = { baseUrl: "https://relay.example/custom/v1", apiKey: "test-token", apiMode: "images" }
const input = { model: "private-model-alias", prompt: "test", aspectRatio: "square", quality: "auto", images: [] }
const result = () => Response.json({ data: [{ b64_json: png }] })

test("custom model and complete API prefix reach the Images request unchanged", async () => {
  let sent: any
  const output = await generateRelayImage(settings, input, undefined, async (url: string, init: RequestInit) => { sent = { url, init }; return result() })
  assert.equal(sent.url, "https://relay.example/custom/v1/images/generations")
  assert.equal(sent.init.headers.Authorization, "Bearer test-token")
  assert.deepEqual(JSON.parse(sent.init.body), { model: "private-model-alias", prompt: "test", n: 1, size: "1024x1024" })
  assert.equal(output.mediaType, "image/png")
})

test("image edits preserve binary reference images with correct multipart fields", async () => {
  for (const images of [[image], [image, image]]) {
    await generateRelayImage(settings, { ...input, images, quality: "high", aspectRatio: "2:3" }, undefined, async (url: string, init: RequestInit) => {
      assert.equal(url.endsWith("/images/edits"), true)
      const form = init.body as FormData
      assert.equal(form.get("model"), "private-model-alias")
      assert.equal(form.get("size"), "1024x1536")
      assert.equal(form.get("quality"), "high")
      const files = form.getAll(images.length === 1 ? "image" : "image[]") as File[]
      assert.equal(files.length, images.length)
      assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), Buffer.from(image.bytes))
      assert.equal((init.headers as Record<string,string>)["Content-Type"], undefined)
      return result()
    })
  }
})

test("chat mode sends configured model and reference image and reads image_url response", async () => {
  await generateRelayImage({ ...settings, apiMode: "chat" }, { ...input, images: [image], aspectRatio: "landscape" }, undefined, async (url: string, init: RequestInit) => {
    assert.equal(url.endsWith("/chat/completions"), true)
    const body = JSON.parse(init.body as string)
    assert.equal(body.model, input.model)
    assert.equal(body.stream, false)
    assert.match(body.messages[0].content[0].text, /16:9/)
    assert.equal(body.messages[0].content[1].image_url.url, `data:image/png;base64,${png}`)
    return Response.json({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }] })
  })
})

test("reads URL, image content, Markdown and text-array relay responses", () => {
  const url = "https://images.example/result.png"
  for (const data of [
    { data: [{ url }] },
    { choices: [{ message: { content: [{ type: "image_url", image_url: { url } }] } }] },
    { choices: [{ message: { content: `![result](${url})` } }] },
    { choices: [{ message: { content: [{ type: "text", text: `![result](${url})` }] } }] },
  ]) assert.equal(extractImageSource(data).source, url)
})

test("text-only success, invalid image data and unsupported aspect ratio fail clearly", async () => {
  assert.throws(() => extractImageSource({ choices: [{ message: { content: "No image available" } }] }), /未返回图片/)
  await assert.rejects(readImageSource("data:image/svg+xml;base64,PHN2Zz4="), /不受支持/)
  assert.throws(() => imageBytes(Buffer.from("not an image")), /图片格式/)
  let sent: any
  await generateRelayImage(settings, { ...input, aspectRatio: "wide" }, undefined, async (url: string, init: RequestInit) => { sent = { url, init }; return result() })
  assert.equal(JSON.parse(sent.init.body).size, "2048x864")
  await assert.rejects(generateRelayImage(settings, { ...input, aspectRatio: "cinema" }, undefined, async () => result()), /宽高比参数无效/)
})

test("upstream errors never echo response credentials or raw bodies", async () => {
  await assert.rejects(generateRelayImage(settings, input, undefined, async () => new Response("test-token echoed here", { status: 401 })), (error: Error) => /Token/.test(error.message) && !error.message.includes("test-token"))
  await assert.rejects(generateRelayImage(settings, input, undefined, async () => new Response("<html>bad gateway</html>")), /有效 JSON/)
})
