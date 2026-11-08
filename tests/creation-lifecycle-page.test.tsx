import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { registerHooks } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { act } from "react"
import { Window } from "happy-dom"
import { IDBFactory } from "fake-indexeddb"
import { AccountVisibilityContext } from "../components/account/account-visibility"
import { emptyWorkspace, mergePrivateWorkspace, readWorkspace, restoreWorkspace, writeWorkspace } from "../lib/creative-workspace"
import type { PrivateCreation, PrivateDeletedCreation, PrivateRun } from "../lib/private-workspace-types"

const win = new Window({ url: "http://localhost:3000" })
const originals = new Map<string, PropertyDescriptor | undefined>()
let createRoot: typeof import("react-dom/client").createRoot
let ImageCombiner: typeof import("../components/image-combiner").ImageCombiner
const decoration = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@paper-design/shaders-react") return { url: "data:text/javascript,export const Dithering = () => null", shortCircuit: true }
  return nextResolve(specifier, context)
} })

before(async () => {
  const globals: Record<string, unknown> = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage,
    indexedDB: new IDBFactory(), IS_REACT_ACT_ENVIRONMENT: true, BroadcastChannel: undefined, getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win) }
  for (const name of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "ResizeObserver", "CustomEvent", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent"] as const) globals[name] = win[name]
  for (const [name, value] of Object.entries(globals)) { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }) }
  ;({ createRoot } = await import("react-dom/client")); ({ ImageCombiner } = await import("../components/image-combiner"))
})
after(async () => {
  decoration.deregister(); await win.happyDOM.close()
  for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name) }
})

async function flush(action?: () => unknown) { await act(async () => { await action?.(); await new Promise<void>(resolve => setImmediate(resolve)) }) }
async function eventually(check: () => void | Promise<void>) {
  let failure: unknown
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await act(async () => { await check() }); return } catch (error) { failure = error }
    await flush(() => delay(10))
  }
  throw failure
}
function button(text: string) {
  const value = [...win.document.querySelectorAll("button")].find(item => item.textContent?.trim() === text)
  assert.ok(value, `Missing button ${text}`)
  return value
}

test("the complete page deletes through its menu and undo restores the same creation, version and local draft", async t => {
  const account = "lifecycle-page-undo"
  const cid = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222"
  const rid = "33333333-3333-4333-8333-333333333333", assetId = "44444444-4444-4444-8444-444444444444"
  const asset = `/api/images/${assetId}`
  const version: PrivateRun = { id: rid, creationId: cid, creationRevision: 7, version: 1, parentVersionId: null, status: "complete", imageUrl: asset,
    prompt: "已保存的首版要求", annotationSnapshot: null, mappingId: "mapping-a", modelLabel: "合成模型", aspectRatio: "3:2", quality: "high", mode: "text-to-image", createdAt: 100, updatedAt: 101 }
  const original: PrivateCreation = { id: cid, title: "待整理创作", revision: 7, createdAt: 90, updatedAt: 110, versions: [version] }
  const other: PrivateCreation = { id: otherId, title: "另一项创作", revision: 1, createdAt: 80, updatedAt: 80, versions: [] }
  let active = [original, other], deleted: PrivateDeletedCreation[] = []
  const writes: Array<{ path: string; method: string; body: unknown }> = [], unexpected: string[] = []
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (method !== "GET") writes.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body })
    if (method === "GET" && path === "/api/version") return Response.json({ version: "development" })
    if (method === "GET" && path === "/api/models") return Response.json({ revision: 1, configured: true, apiMode: "images", mappings: [{ id: "mapping-a", name: "合成模型", aspectRatios: ["square", "3:2"] }] })
    if (method === "GET" && path === "/api/creations") return Response.json({ creations: active, deletedCreations: deleted })
    if (method === "GET" && path === `${asset}/metadata`) return Response.json({ assetId, width: 300, height: 200, orientation: 1, pages: 1 })
    if (method === "DELETE" && path === `/api/creations/${cid}`) {
      active = [other]; deleted = [{ id: cid, revision: 8, deletedAt: 200 }]
      return Response.json({ deletion: deleted[0] })
    }
    if (method === "POST" && path === `/api/creations/${cid}/restore`) {
      const restored = { ...original, revision: 9, versions: [{ ...version, creationRevision: 9 }] }
      active = [restored, other]; deleted = []
      return Response.json({ creation: restored })
    }
    unexpected.push(`${method} ${path}`)
    throw new Error(`Unexpected synthetic request: ${method} ${path}`)
  })
  const reference = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "本机参考.png", { type: "image/png" })
  const document = new File(["只留在本机的背景内容"], "背景.txt", { type: "text/plain" })
  const seed = mergePrivateWorkspace(emptyWorkspace(), active)
  Object.assign(seed.creations[0].draft, { prompt: "尚未提交的修改要求", image1: reference, documentName: document.name, documentText: "只留在本机的背景内容", documentFile: document, documentImageInspection: "none" })
  await writeWorkspace(seed, 0, "lifecycle-page-seed", account)
  const container = win.document.createElement("div"); win.document.body.append(container)
  const root = createRoot(container as unknown as HTMLElement)
  t.after(async () => { await flush(() => root.unmount()); await delay(25); container.remove(); win.localStorage.clear(); win.sessionStorage.clear(); win.document.body.style.pointerEvents = "" })
  await flush(() => root.render(<AccountVisibilityContext.Provider value={true}><ImageCombiner accountId={account} /></AccountVisibilityContext.Provider>))
  const selectedCreation = () => win.document.querySelector<InstanceType<typeof win.HTMLSelectElement>>("#active-creation")?.value
  const prompt = () => win.document.querySelector<InstanceType<typeof win.HTMLTextAreaElement>>("#creation-prompt")?.value
  await eventually(() => {
    assert.equal(selectedCreation(), cid)
    assert.equal(prompt(), "尚未提交的修改要求")
    assert.ok(win.document.querySelector('[aria-label="选择 V1"][aria-pressed="true"]'))
  })

  await flush(() => win.document.querySelector('[aria-label="创作操作 待整理创作"]')!.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
  await eventually(() => assert.ok(win.document.querySelector('[role="menuitem"]')))
  await flush(() => [...win.document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes("删除创作"))!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })))
  await eventually(() => assert.match(win.document.querySelector('[role="alertdialog"]')?.textContent ?? "", /删除「待整理创作」/))
  assert.equal(writes.length, 0)
  await flush(() => button("删除创作").click())
  await eventually(() => {
    assert.equal(win.document.querySelector('[role="alertdialog"]'), null)
    assert.equal(selectedCreation(), otherId)
    assert.equal(win.document.querySelector(`#active-creation option[value="${cid}"]`), null)
    assert.match(win.document.querySelector('[aria-label="删除操作反馈"]')?.textContent ?? "", /已删除「待整理创作」/)
    assert.equal(button("撤销删除").disabled, false)
  })
  await eventually(async () => assert.equal(restoreWorkspace(await readWorkspace(account)).creations.some(creation => creation.id === cid), false))
  assert.deepEqual(writes, [{ path: `/api/creations/${cid}`, method: "DELETE", body: { revision: 7 } }])

  await flush(() => button("撤销删除").click())
  await eventually(() => {
    assert.equal(selectedCreation(), cid)
    assert.equal(prompt(), "尚未提交的修改要求")
    assert.equal(win.document.querySelector('[aria-label="删除操作反馈"]'), null)
    assert.ok(win.document.querySelector('[aria-label="选择 V1"][aria-pressed="true"]'))
    const restoredImage = win.document.querySelector('img[alt="V1：已保存的首版要求"]')?.getAttribute("src")
    assert.ok(restoredImage)
    assert.equal(new URL(restoredImage, "http://localhost:3000").pathname, asset)
    assert.ok(win.document.querySelector('[aria-label="清空第 1 张图片"]'))
    assert.ok(win.document.querySelector('[aria-label="移除背景文档"]'))
  })
  await eventually(async () => {
    const saved = restoreWorkspace(await readWorkspace(account))
    assert.equal(saved.activeCreationId, cid)
    assert.deepEqual(saved.creations.map(creation => creation.id).sort(), [cid, otherId].sort())
    const restored = saved.creations.find(creation => creation.id === cid)!
    assert.equal(restored.selectedVersionId, rid)
    assert.equal(restored.versions.length, 1)
    assert.equal(restored.versions[0].id, rid); assert.equal(restored.versions[0].status, "complete"); assert.equal(restored.versions[0].imageUrl, asset)
    assert.equal(restored.draft.prompt, "尚未提交的修改要求")
    assert.deepEqual(new Uint8Array(await restored.draft.image1!.arrayBuffer()), new Uint8Array(await reference.arrayBuffer()))
    assert.equal(restored.draft.documentText, "只留在本机的背景内容")
    assert.equal(await restored.draft.documentFile!.text(), await document.text())
  })
  assert.deepEqual(writes, [{ path: `/api/creations/${cid}`, method: "DELETE", body: { revision: 7 } }, { path: `/api/creations/${cid}/restore`, method: "POST", body: { revision: 8 } }])
  assert.deepEqual(unexpected, [])
})
