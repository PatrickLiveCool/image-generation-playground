import assert from "node:assert/strict"
import { after, before, test, type TestContext } from "node:test"
import { Window } from "happy-dom"
import { act, useState } from "react"
import { AnnotationCanvas, AnnotationList, AnnotationSnapshotPreview, AnnotationTools, addCenterAnnotation, useAnnotationEditor } from "../components/image-combiner/annotation-editor"
import { useAnnotationMetadata } from "../components/image-combiner/hooks/use-annotation-metadata"
import { AccountVisibilityContext } from "../components/account/account-visibility"
import { CreationHistory } from "../components/image-combiner/creation-history"
import { createEmptyAnnotationSnapshot, type AnnotationDraft } from "../lib/image-annotations"

const win = new Window({ url: "http://localhost:3000" })
const originals = new Map<string, PropertyDescriptor | undefined>()
let createRoot: typeof import("react-dom/client").createRoot
before(async () => {
  const globals: Record<string, unknown> = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: win.getComputedStyle.bind(win) }
  for (const key of ["HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "ResizeObserver"] as const) globals[key] = win[key]
  for (const [name, value] of Object.entries(globals)) { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }) }
  ;({ createRoot } = await import("react-dom/client"))
})
after(async () => { await win.happyDOM.close(); for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name) } })
const base = "11111111-1111-4111-8111-111111111111", asset = "22222222-2222-4222-8222-222222222222", nextAsset = "33333333-3333-4333-8333-333333333333"
const metadata = { assetId: asset, width: 400, height: 200, orientation: 1, pages: 1 as const }
async function flush(action?: () => void) { await act(async () => { action?.(); await new Promise<void>(resolve => setImmediate(resolve)) }) }
function button(text: string) { const value = [...win.document.querySelectorAll("button")].find(item => item.textContent === text); assert.ok(value, `Missing button ${text}`); return value }
async function type(label: string, text: string) { await flush(() => { const field = win.document.querySelector(`textarea[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new win.Event("input", { bubbles: true })) }) }
function box(x: number, y: number, width: number, height: number) { return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() { return {} } } }

async function mountEditor(t: TestContext, containerWidth = 300, initial?: AnnotationDraft) {
  let latest: AnnotationDraft | undefined, submissions = 0
  t.mock.method(win.HTMLElement.prototype, "getBoundingClientRect", function (this: InstanceType<typeof win.HTMLElement>) { return box(0, 0, containerWidth, 400) })
  t.mock.method(win.SVGElement.prototype, "getBoundingClientRect", function (this: InstanceType<typeof win.SVGElement>) { return box(0, 125, 300, 150) })
  Object.defineProperty(win.SVGElement.prototype, "setPointerCapture", { configurable: true, value: () => {} })
  t.after(() => Reflect.deleteProperty(win.SVGElement.prototype, "setPointerCapture"))
  function Probe({ disabled = false }: { disabled?: boolean }) {
    const [draft, setDraft] = useState<AnnotationDraft>(initial ?? { snapshot: createEmptyAnnotationSnapshot(base, metadata), revision: 0, nextNumber: 1 })
    latest = draft
    const editor = useAnnotationEditor(draft, setDraft, base)
    const [tool, setTool] = useState<"rectangle" | "lasso" | "brush" | null>(null)
    return <><AnnotationTools editor={editor} disabledReason={disabled ? "任务正在处理" : undefined} tool={tool} setTool={setTool} addCenter={() => addCenterAnnotation(editor)} /><AnnotationList editor={editor} onSubmit={() => submissions++} /><AnnotationCanvas editor={editor} tool={tool} disabled={disabled} onSubmit={() => submissions++} /></>
  }
  const container = win.document.createElement("div"); win.document.body.append(container)
  const root = createRoot(container as unknown as HTMLElement)
  const render = async (disabled = false) => { await act(async () => root.render(<Probe disabled={disabled} />)) }
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await render()
  return { state: () => latest!, submissions: () => submissions, render }
}

test("center region shares instructions with the floating editor, keeps stable numbers through delete/undo, and submits by keyboard", async t => {
  const view = await mountEditor(t)
  await flush(() => button("添加中心区域").click())
  assert.equal(view.state().snapshot.marks[0].number, 1)
  await type("批注 1 的说明", "make it red ")
  assert.equal((win.document.querySelector('textarea[aria-label="图上批注 1 的说明"]') as InstanceType<typeof win.HTMLTextAreaElement>).value, "make it red ")
  await type("图上批注 1 的说明", "改成绿色\n")
  assert.equal((win.document.querySelector('textarea[aria-label="批注 1 的说明"]') as InstanceType<typeof win.HTMLTextAreaElement>).value, "改成绿色\n")
  await flush(() => button("添加中心区域").click())
  await flush(() => win.document.querySelector<InstanceType<typeof win.HTMLButtonElement>>('[aria-label="删除批注 1"]')!.click())
  assert.deepEqual(view.state().snapshot.marks.map(mark => mark.number), [2])
  await flush(() => button("撤销").click())
  assert.deepEqual(view.state().snapshot.marks.map(mark => mark.number), [1, 2])
  await flush(() => button("添加中心区域").click())
  assert.deepEqual(view.state().snapshot.marks.map(mark => mark.number), [1, 2, 3])
  const input = win.document.querySelector('textarea[aria-label="批注 3 的说明"]')!
  await flush(() => input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })))
  assert.equal(view.submissions(), 1)
  assert.equal(win.document.querySelector('[data-annotation-canvas] button[type="submit"]'), null)
})

test("self-intersecting and repeated-winding lassos use the same even-odd regions in editor and historical preview", async t => {
  const paths = [
    [{ x: 20, y: 20 }, { x: 100, y: 100 }, { x: 20, y: 100 }, { x: 100, y: 20 }],
    [{ x: 140, y: 20 }, { x: 220, y: 20 }, { x: 220, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 20 }, { x: 220, y: 20 }, { x: 220, y: 100 }, { x: 140, y: 100 }],
  ]
  const snapshot = { ...createEmptyAnnotationSnapshot(base, metadata), marks: paths.map((points, index) => ({ id: `${index + 4}4444444-4444-4444-8444-444444444444`, number: index + 1, instruction: "保留奇偶区域", geometry: { type: "lasso" as const, points } })) }
  await mountEditor(t, 300, { snapshot, revision: 1, nextNumber: 3 })
  const container = win.document.createElement("div"); win.document.body.append(container); const root = createRoot(container as unknown as HTMLElement)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => root.render(<AnnotationSnapshotPreview snapshot={snapshot} />))
  await flush(() => button("查看原图批注").click())
  const polygons = [...win.document.querySelectorAll("polygon")]
  assert.equal(polygons.length, 4)
  for (const [index, polygon] of polygons.entries()) {
    assert.equal(polygon.getAttribute("fill-rule"), "evenodd")
    assert.equal(polygon.getAttribute("points"), paths[index % 2].map(point => `${point.x},${point.y}`).join(" "))
  }
})

test("all pointer tools store original pixels from the actual image rectangle; keyboard move and resize do not navigate history", async t => {
  const view = await mountEditor(t)
  const draw = async (tool: string, points: [number, number][]) => {
    await flush(() => button(tool).click())
    const svg = win.document.querySelector('svg[aria-label="图片区域批注画布"]')!
    await flush(() => svg.dispatchEvent(new win.PointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: points[0][0], clientY: points[0][1], bubbles: true })))
    for (const [clientX, clientY] of points.slice(1, -1)) await flush(() => svg.dispatchEvent(new win.PointerEvent("pointermove", { pointerId: 1, clientX, clientY, bubbles: true })))
    const [clientX, clientY] = points.at(-1)!
    await flush(() => svg.dispatchEvent(new win.PointerEvent("pointerup", { pointerId: 1, clientX, clientY, bubbles: true })))
  }
  await draw("矩形", [[30, 140], [90, 185]])
  assert.deepEqual(view.state().snapshot.marks[0].geometry, { type: "rectangle", x: 40, y: 20, width: 80, height: 60 })
  await draw("自由圈选", [[30, 140], [90, 140], [60, 185]])
  await draw("涂抹", [[100, 180], [120, 180], [140, 200]])
  assert.deepEqual(view.state().snapshot.marks.map(mark => mark.geometry.type), ["rectangle", "lasso", "brush"])
  let historyKeys = 0
  const listener = () => historyKeys++
  win.addEventListener("keydown", listener); t.after(() => win.removeEventListener("keydown", listener))
  const mark = win.document.querySelector(`[data-annotation-id="${view.state().snapshot.marks[0].id}"]`)!
  await flush(() => mark.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })))
  await flush(() => mark.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true })))
  assert.deepEqual(view.state().snapshot.marks[0].geometry, { type: "rectangle", x: 42, y: 20, width: 80, height: 62 })
  await flush(() => mark.dispatchEvent(new win.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })))
  assert.deepEqual(view.state().snapshot.marks[0].geometry, { type: "rectangle", x: 42, y: 20, width: 80, height: 60 })
  assert.equal(historyKeys, 0)
  const before = structuredClone(view.state())
  await view.render(true)
  assert.equal(button("添加中心区域").disabled, true)
  await flush(() => mark.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })))
  assert.deepEqual(view.state(), before)
  await type("批注 1 的说明", "保留生成期间的新说明")
  assert.equal(view.state().snapshot.marks[0].instruction, "保留生成期间的新说明")
})

test("the shared floating instruction remains inside a narrow image panel", async t => {
  await mountEditor(t, 160)
  await flush(() => button("添加中心区域").click())
  const panel = win.document.querySelector('textarea[aria-label="图上批注 1 的说明"]')!.parentElement! as InstanceType<typeof win.HTMLElement>
  const left = Number.parseFloat(panel.style.left), width = Number.parseFloat(panel.style.width)
  assert.ok(left >= 0 && width > 0 && left + width <= 160)
  await type("图上批注 1 的说明", "窄屏仍可编辑")
  assert.equal((win.document.querySelector('textarea[aria-label="批注 1 的说明"]') as InstanceType<typeof win.HTMLTextAreaElement>).value, "窄屏仍可编辑")
})

test("metadata requests abort on changed base or hidden account and ignore late authenticated responses", async t => {
  const replies: { resolve: (response: Response) => void; signal?: AbortSignal | null }[] = []
  t.mock.method(globalThis, "fetch", async (_path: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => replies.push({ resolve, signal: init?.signal })))
  let latest: ReturnType<typeof useAnnotationMetadata> | undefined
  const current = () => latest
  function Probe({ id }: { id: string }) { latest = useAnnotationMetadata(`/api/images/${id}`, base); return null }
  const container = win.document.createElement("div"); win.document.body.append(container); const root = createRoot(container as unknown as HTMLElement)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  const render = async (id: string, visible = true) => { await act(async () => root.render(<AccountVisibilityContext.Provider value={visible}><Probe id={id} /></AccountVisibilityContext.Provider>)) }
  await render(asset); await render(nextAsset)
  assert.equal(replies[0].signal?.aborted, true)
  await flush(() => replies[0].resolve(Response.json(metadata)))
  assert.equal(current()?.metadata, undefined)
  await flush(() => replies[1].resolve(Response.json({ ...metadata, assetId: nextAsset })))
  assert.equal(current()?.metadata?.assetId, nextAsset)
  await render(asset); await render(asset, false)
  assert.equal(replies[2].signal?.aborted, true)
  await flush(() => replies[2].resolve(Response.json(metadata)))
  assert.equal(current()?.metadata, undefined)
})

test("metadata retry recovers a transient failure and an older retry cannot overwrite the new result", async t => {
  const replies: { resolve: (response: Response) => void; signal?: AbortSignal | null }[] = []
  t.mock.method(globalThis, "fetch", async (_path: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(resolve => replies.push({ resolve, signal: init?.signal })))
  let latest: ReturnType<typeof useAnnotationMetadata> | undefined
  const current = () => latest!
  function Probe() { latest = useAnnotationMetadata(`/api/images/${asset}`, base); return null }
  const container = win.document.createElement("div"); win.document.body.append(container); const root = createRoot(container as unknown as HTMLElement)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => root.render(<Probe />))
  await flush(() => replies[0].resolve(Response.json({ error: { message: "临时不可读" } }, { status: 503 })))
  assert.equal(current().error, "临时不可读")
  await flush(() => current().retry())
  assert.equal(current().error, undefined)
  await flush(() => current().retry())
  assert.equal(replies[1].signal?.aborted, true)
  await flush(() => replies[2].resolve(Response.json(metadata)))
  assert.deepEqual(current().metadata, metadata)
  await flush(() => replies[1].resolve(Response.json({ ...metadata, width: 100 })))
  assert.deepEqual(current().metadata, metadata)
})

test("new-device history displays server annotation instructions and source version without a local draft", async t => {
  const snapshot = { ...createEmptyAnnotationSnapshot(base, metadata), marks: [{ id: "44444444-4444-4444-8444-444444444444", number: 8, instruction: "服务器保存的说明", geometry: { type: "rectangle" as const, x: 1, y: 1, width: 10, height: 10 } }] }
  const versions = [{ id: base, version: 1, parentVersionId: null, status: "complete" as const, imageUrl: `/api/images/${asset}`, prompt: "", progress: 100, timestamp: 1 }, { id: nextAsset, version: 2, parentVersionId: base, status: "complete" as const, imageUrl: `/api/images/${nextAsset}`, prompt: "", progress: 100, timestamp: 2, annotationSnapshot: snapshot }]
  const container = win.document.createElement("div"); win.document.body.append(container); const root = createRoot(container as unknown as HTMLElement)
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => root.render(<CreationHistory generations={versions} selectedId={nextAsset} pending={false} onSelect={() => {}} onCancel={() => {}} />))
  assert.match(container.textContent, /基于 V1.*8\. 服务器保存的说明/)
  await flush(() => button("查看原图批注").click())
  assert.equal(container.querySelector('img[alt="已提交批注的原始基准图"]')?.getAttribute("src"), `/api/images/${asset}`)
  assert.ok(container.querySelector('svg[aria-label="已提交的区域快照"] rect'))
})
