import { strict as assert } from "node:assert"
import { after, test } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import ts from "typescript"
import type { Creation, CreationDraft } from "../lib/creation-types"
import type { Generation } from "../components/image-combiner/types"
import type { BuildCreationRequestInput } from "../lib/creation-request"

const dir = mkdtempSync(path.join(tmpdir(), "creation-request-"))
for (const name of ["api-provider-types", "model-mappings", "document-context", "creation-request"]) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8")
  writeFileSync(path.join(dir, `${name}.js`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
}
const require = createRequire(import.meta.url)
const { buildCreationRequest } = require(path.join(dir, "creation-request.js")) as { buildCreationRequest: (input: BuildCreationRequestInput) => { formData: FormData; generation: Generation } }
after(() => rmSync(dir, { recursive: true, force: true }))

const creationId = "11111111-1111-4111-8111-111111111111"
const generationId = "22222222-2222-4222-8222-222222222222"
const originalImage = "/api/assets/image-playground/runs/legacy/outputs/final.png?access=original-capability"
const settings = { baseUrl: " https://relay.example/v1/ ", apiKey: " test-token ", apiMode: "images" as const }
const mappings = [{ id: "quality", name: " 极致 ", modelId: " provider-model-a " }, { id: "balanced", name: "均衡", modelId: "provider-model-b" }]
const reference = (name = "reference.png") => new File([new Uint8Array([137,80,78,71])], name, { type: "image/png" })
function creation(draft: Partial<CreationDraft> = {}, versions: Generation[] = [], selectedVersionId: string | null = null): Creation {
  return {
    id: creationId, title: "山行海报", createdAt: 100, updatedAt: 100, selectedVersionId, versions,
    unread: false, draftRevision: 3, pendingDraftRevision: null,
    draft: { prompt: "  只把标题改为秋日山行\n其余保持不变。  ", selectedMappingId: "quality", aspectRatio: "square", quality: "auto", useUrls: false, image1: null, image2: null, image1Url: "", image2Url: "", ...draft },
  }
}
function version(id: string, number: number, patch: Partial<Generation> = {}): Generation {
  return { id, version: number, status: "complete", progress: 100, imageUrl: originalImage, prompt: "旧提示词", timestamp: number, ...patch }
}
const build = (value: Creation, overrides: Partial<BuildCreationRequestInput> = {}) => buildCreationRequest({ creation: value, settings, mappings, generationId, now: 1234, ...overrides })

test("first request resolves the stable alias to its current model and snapshots the original prompt", () => {
  const current = creation()
  const before = structuredClone(current)
  const { formData, generation } = build(current)
  assert.equal(formData.get("selectedModel"), "provider-model-a")
  assert.equal(formData.get("baseUrl"), "https://relay.example/v1")
  assert.equal(formData.get("apiKey"), "test-token")
  assert.equal(formData.get("prompt"), current.draft.prompt)
  assert.equal(formData.get("version"), "1")
  assert.equal(formData.get("creationId"), creationId)
  assert.equal(formData.get("clientVersionId"), generationId)
  assert.equal(formData.get("mode"), "text-to-image")
  assert.equal(formData.has("baseImageUrl"), false)
  assert.equal(formData.has("parentVersionId"), false)
  assert.equal(generation.modelLabel, "极致")
  assert.equal(generation.model, "provider-model-a")
  assert.equal(generation.parentVersionId, null)
  assert.equal(generation.timestamp, 1234)
  assert.equal(generation.prompt, current.draft.prompt)
  assert.deepEqual(current, before)
  current.draft.prompt = "another task's draft"
  assert.notEqual(formData.get("prompt"), current.draft.prompt)
  assert.notEqual(generation.prompt, current.draft.prompt)
  for (const secret of ["test-token", "relay.example", "original-capability"]) assert.equal(JSON.stringify(generation).includes(secret), false)
})

test("a text document is sent as bounded prompt context while the visible generation prompt stays clean", () => {
  const current = creation({ documentName: "poster-brief.md", documentText: "春季市集海报，主色为绿色。" })
  const { formData, generation } = build(current)
  assert.equal(formData.get("prompt"), "  只把标题改为秋日山行\n其余保持不变。  \n\n【文档上下文：poster-brief.md】\n春季市集海报，主色为绿色。\n【文档上下文结束】")
  assert.equal(generation.prompt, current.draft.prompt)
})

test("a PDF or Word attachment is captured in the multipart request for server parsing and COS archiving", () => {
  const document = new File(["PK"], "poster-brief.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
  const { formData, generation } = build(creation({ documentName: document.name, documentFile: document }))
  assert.equal((formData.get("document") as File).name, document.name)
  assert.equal(generation.prompt, creation().draft.prompt)
})

test("a document that makes the submitted prompt exceed the provider limit is rejected", () => {
  assert.throws(() => build(creation({ prompt: "p".repeat(1_000), documentName: "brief.txt", documentText: "x".repeat(4_000) })), /合计不能超过 5000 字/)
})

test("editing sends the selected original asset and parent with one additional reference", async () => {
  const image = reference()
  const current = creation({ image1: image }, [version("gen-v1", 1)], "gen-v1")
  const { formData, generation } = build(current)
  assert.equal(formData.get("baseImageUrl"), originalImage)
  assert.equal(formData.get("parentVersionId"), "gen-v1")
  assert.equal(formData.get("mode"), "image-editing")
  assert.equal(formData.get("version"), "2")
  assert.deepEqual(new Uint8Array(await (formData.get("image1") as File).arrayBuffer()), new Uint8Array(await image.arrayBuffer()))
  assert.equal(formData.has("image2"), false)
  assert.equal(generation.parentVersionId, "gen-v1")
  assert.equal(generation.version, 2)
  assert.equal(generation.prompt, current.draft.prompt)
  assert.equal(generation.prompt.includes("旧提示词"), false)
})

test("branching from V1 after V2 creates V3 and ignores failed attempt numbers", () => {
  const current = creation({}, [version("gen-v1", 1), version("gen-v2", 2), version("failed", 99, { status: "error", imageUrl: null })], "gen-v1")
  const { formData, generation } = build(current)
  assert.equal(formData.get("version"), "3")
  assert.equal(formData.get("parentVersionId"), "gen-v1")
  assert.equal(generation.version, 3)
})

test("initial generation keeps two references and a single occupied second slot is retained on edit", () => {
  const initial = build(creation({ useUrls: true, image1Url: " https://images.example/first.png ", image2Url: "https://images.example/second.png" }))
  assert.equal(initial.formData.get("image1Url"), "https://images.example/first.png")
  assert.equal(initial.formData.get("image2Url"), "https://images.example/second.png")
  assert.equal(initial.formData.get("mode"), "image-editing")
  const edit = build(creation({ useUrls: true, image2Url: "https://images.example/extra.png" }, [version("gen-v1", 1)], "gen-v1"))
  assert.equal(edit.formData.get("image1Url"), "https://images.example/extra.png")
  assert.equal(edit.formData.has("image2Url"), false)
})

test("two supplemental references reject instead of being silently dropped", () => {
  for (const draft of [
    { image1: reference("one.png"), image2: reference("two.png") },
    { useUrls: true, image1Url: "https://images.example/one.png", image2Url: "https://images.example/two.png" },
  ]) assert.throws(() => build(creation(draft, [version("gen-v1", 1)], "gen-v1")), /最多添加一张补充参考图/)
})

test("an unavailable selected version rejects instead of turning into a new generation", () => {
  for (const versions of [[], [version("gen-v1", 1, { imageUrl: null })], [version("gen-v1", 1, { imageUrl: " " })], [version("gen-v1", 1, { status: "error" })]]) {
    assert.throws(() => build(creation({}, versions, "gen-v1")), /所选基准版本没有可用图片/)
  }
})

test("mixed reference input modes reject before either set can be discarded", () => {
  for (const useUrls of [true, false]) assert.throws(() => build(creation({ useUrls, image1: reference(), image1Url: "https://images.example/reference.png" })), /文件与链接中都有参考图/)
  assert.throws(() => build(creation({ useUrls: true, image1Url: "http://images.example/reference.png" })), /HTTPS/)
  assert.throws(() => build(creation({ image1: new File([], "empty.png") })), /不能为空/)
  assert.throws(() => build(creation({ image1: new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png") })), /10 MB/)
})

test("invalid connection, mapping, prompt and reference parameters cannot create a request", () => {
  for (const invalid of [
    { ...settings, baseUrl: "" }, { ...settings, baseUrl: "http://relay.example" },
    { ...settings, baseUrl: "https://relay.example?key=secret" }, { ...settings, apiKey: " " },
    { ...settings, apiKey: "token\n" }, { ...settings, apiMode: "unsupported" as never },
  ]) assert.throws(() => build(creation(), { settings: invalid }))
  assert.throws(() => build(creation({ selectedMappingId: "deleted" })), /模型映射/)
  assert.throws(() => build(creation(), { mappings: [{ ...mappings[0], modelId: "bad\nmodel" }] }), /模型 ID/)
  assert.throws(() => build(creation({ prompt: "  " })), /提示词/)
  assert.throws(() => build(creation({ prompt: "a".repeat(5001) })), /5000/)
  const wideRequest = build(creation({ aspectRatio: "landscape" }))
  assert.equal(wideRequest.formData.get("aspectRatio"), "landscape")
  assert.throws(() => build(creation({ quality: "unknown" as never })), /画质参数/)
})

test("current mapping changes apply without depending on a model name baked into history", () => {
  const result = build(creation({}, [version("gen-v1", 1, { model: "old-model", modelLabel: "旧名称" })], "gen-v1"), { mappings: [{ id: "quality", name: "极致", modelId: "new-model" }] })
  assert.equal(result.formData.get("selectedModel"), "new-model")
  assert.equal(result.generation.model, "new-model")
})

test("new identifiers default to UUIDs and concurrent requests in one creation are rejected", () => {
  const { generation, formData } = buildCreationRequest({ creation: creation(), settings, mappings })
  assert.match(generation.id, /^[0-9a-f-]{36}$/)
  assert.equal(formData.get("clientVersionId"), generation.id)
  assert.throws(() => build(creation({}, [version("pending", 2, { status: "loading", imageUrl: null })])), /正在生成/)
  assert.throws(() => build(creation(), { generationId: "invalid" }), /标识无效/)
})
