import assert from "node:assert/strict"
import { after, before, test, type TestContext } from "node:test"
import { registerHooks } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { IDBFactory } from "fake-indexeddb"
import { Window } from "happy-dom"
import { act } from "react"
import type { Root } from "react-dom/client"
import { addCreation, emptyWorkspace, newCreation, readWorkspace, restoreWorkspace, writeWorkspace } from "../lib/creative-workspace"
import { publicAnnotationCapability } from "../lib/annotation-capability"
import type { PublicModelCatalog } from "../lib/provider-configuration-types"

const win = new Window({ url: "http://localhost:3000" })
const originals = new Map<string, PropertyDescriptor | undefined>()
let createRoot: typeof import("react-dom/client").createRoot
let ImageCombiner: typeof import("../components/image-combiner").ImageCombiner
// Only the decorative WebGL renderer is replaced; the actual editor, selectors,
// catalog client/hooks and IndexedDB persistence run unchanged in happy-dom.
const decorativeShader = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@paper-design/shaders-react") return { url: "data:text/javascript,export const Dithering = () => null", shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

before(async () => {
  const values: Record<string, unknown> = {
    window: win, document: win.document, navigator: win.navigator,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage, indexedDB: new IDBFactory(),
    IS_REACT_ACT_ENVIRONMENT: true, BroadcastChannel: undefined,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  }
  for (const name of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "ResizeObserver", "CustomEvent", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent"] as const) values[name] = win[name]
  for (const [name, value] of Object.entries(values)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import("react-dom/client"))
  ;({ ImageCombiner } = await import("../components/image-combiner"))
})

after(async () => {
  decorativeShader.deregister()
  await win.happyDOM.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

const catalog: PublicModelCatalog = {
  revision: 1, configured: true, apiMode: "images",
  mappings: [
    { id: "mapping-a", name: "模型 A", aspectRatios: ["square", "3:2", "2:3"], annotation: publicAnnotationCapability(null) },
    { id: "mapping-b", name: "模型 B", aspectRatios: ["square", "landscape", "3:2"], annotation: publicAnnotationCapability(null) },
    { id: "mapping-c", name: "模型 C", aspectRatios: ["square", "2:3"], annotation: publicAnnotationCapability(null) },
  ],
}

async function flush(action?: () => void) {
  await act(async () => { action?.(); await new Promise<void>(resolve => setImmediate(resolve)) })
}
async function eventually(check: () => void | Promise<void>) {
  let failure: unknown
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await act(async () => { await check() }); return } catch (error) { failure = error }
    await act(async () => { await delay(10) })
  }
  throw failure
}
function button(text: string) {
  const result = [...win.document.querySelectorAll("button")].find(item => item.textContent?.trim() === text)
  assert.ok(result, `Missing button ${text}`)
  return result
}
function labelledButton(label: string) {
  const result = win.document.querySelector(`button[aria-label="${label}"]`)
  assert.ok(result instanceof win.HTMLButtonElement, `Missing button ${label}`)
  return result
}
async function chooseModel(name: string) {
  await flush(() => labelledButton("选择模型").click())
  await flush(() => button(name).click())
  assert.equal(labelledButton("选择模型").textContent, name)
}
async function ratioOptions() {
  await flush(() => labelledButton("选择宽高比").dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })))
  const options = [...win.document.querySelectorAll('[role="option"]')].map(option => option.textContent)
  await flush(() => win.document.querySelector('[role="listbox"]')!.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
  return options
}

async function mount(context: TestContext, accountId: string, replies: PublicModelCatalog[]) {
  const requests: { path: string; init?: RequestInit }[] = []
  context.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    requests.push({ path, init })
    if (path === "/api/version") return Response.json({ version: "development" })
    if (path === "/api/creations") return Response.json({ creations: [{ id: "11111111-1111-4111-8111-111111111111", title: "测试创作", revision: 1, createdAt: 100, updatedAt: 100, versions: [] }] })
    assert.equal(path, "/api/models", "UI verification must never call a generation or external endpoint")
    const reply = replies.shift()
    assert.ok(reply, "Unexpected catalog request")
    return Response.json(reply)
  })
  const creation = newCreation({ prompt: "合成测试提示词", selectedMappingId: "mapping-a", aspectRatio: "3:2" }, "11111111-1111-4111-8111-111111111111")
  await writeWorkspace(addCreation(emptyWorkspace(), creation), 0, "catalog-ui-seed", accountId)
  const container = win.document.createElement("div")
  win.document.body.append(container)
  const root: Root = createRoot(container as unknown as HTMLElement)
  context.after(async () => {
    await act(async () => root.unmount())
    await delay(25)
    container.remove()
    win.document.body.style.pointerEvents = ""
    win.localStorage.clear()
    win.sessionStorage.clear()
    assert.equal(replies.length, 0, "All expected catalog responses were consumed")
  })
  await act(async () => root.render(<ImageCombiner accountId={accountId} />))
  await eventually(() => {
    assert.equal(labelledButton("选择模型").textContent, "模型 A")
    assert.equal(button("生成图片").disabled, false)
  })
  const draft = async () => restoreWorkspace(await readWorkspace(accountId)).creations[0].draft
  return { requests, draft }
}

test("真实创作界面使用目录比例，切换模型保留合法比例并修正不支持的比例", async context => {
  const { draft } = await mount(context, "catalog-ratios-user", [catalog])
  assert.deepEqual(await ratioOptions(), ["1:1", "3:2", "2:3"])
  assert.equal(labelledButton("选择宽高比").textContent, "3:2")

  await chooseModel("模型 B")
  assert.deepEqual(await ratioOptions(), ["1:1", "16:9", "3:2"])
  assert.equal(labelledButton("选择宽高比").textContent, "3:2")
  await eventually(async () => {
    assert.equal((await draft()).selectedMappingId, "mapping-b")
    assert.equal((await draft()).aspectRatio, "3:2")
  })

  await chooseModel("模型 C")
  assert.deepEqual(await ratioOptions(), ["1:1", "2:3"])
  assert.equal(labelledButton("选择宽高比").textContent, "1:1")
  await eventually(async () => {
    assert.equal((await draft()).selectedMappingId, "mapping-c")
    assert.equal((await draft()).aspectRatio, "square")
  })
})

test("已选模型被刷新删除后保留草稿选择、提示且禁止生成，明确重选后恢复", async context => {
  const updated = { ...catalog, revision: 2, mappings: [catalog.mappings[1]] }
  const { requests, draft } = await mount(context, "catalog-deletion-user", [catalog, updated])
  await flush(() => button("刷新模型").click())
  assert.match(win.document.body.textContent, /之前选择的模型已被移除，请重新选择模型/)
  assert.equal(labelledButton("选择模型").textContent, "选择模型")
  assert.equal(button("生成图片").disabled, true)
  // Give the real debounced persistence path time to expose an accidental fallback.
  await act(async () => { await delay(220) })
  assert.equal((await draft()).selectedMappingId, "mapping-a")
  await flush(() => button("生成图片").click())
  assert.ok(requests.every(request => request.path === "/api/models" || request.path === "/api/version" || request.path === "/api/creations"))

  await chooseModel("模型 B")
  assert.doesNotMatch(win.document.body.textContent, /之前选择的模型已被移除/)
  assert.equal(button("生成图片").disabled, false)
  await eventually(async () => assert.equal((await draft()).selectedMappingId, "mapping-b"))
  assert.equal(requests.filter(request => request.path === "/api/models").length, 2)
})
