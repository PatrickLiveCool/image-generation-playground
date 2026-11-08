import assert from "node:assert/strict"
import { after, before, test, type TestContext } from "node:test"
import { createRequire, registerHooks } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { act } from "react"
import { Window } from "happy-dom"
import type { Root } from "react-dom/client"

const win = new Window({ url: "http://localhost:3000" })
const originals = new Map<string, PropertyDescriptor | undefined>()
const observers = new Set<() => void>()
const storageKey = "image-playground.editor-layout.v1"
let width = 1212
let createRoot: typeof import("react-dom/client").createRoot
let EditorLayout: typeof import("../components/image-combiner/editor-layout").EditorLayout
// This component test runs a browser tree; the package's Node export intentionally
// omits its layout effects and cannot exercise panel registration or keyboard input.
const require = createRequire(import.meta.url)
const browserPanels = pathToFileURL(resolve(dirname(require.resolve("react-resizable-panels")), "react-resizable-panels.browser.cjs.mjs")).href
const browserHook = registerHooks({ resolve(specifier, context, nextResolve) { return specifier === "react-resizable-panels" ? { url: browserPanels, shortCircuit: true } : nextResolve(specifier, context) } })

before(async () => {
  win.happyDOM.setWindowSize({ width: 1440, height: 900 })
  const globals: Record<string, unknown> = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), ResizeObserver: class {
    callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe() { observers.add(this.callback) }
    disconnect() { observers.delete(this.callback) }
    unobserve() {}
  } }
  for (const name of ["HTMLElement", "Element", "Node", "MouseEvent", "PointerEvent", "KeyboardEvent", "MutationObserver"] as const) globals[name] = win[name]
  for (const [name, value] of Object.entries(globals)) { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }) }
  win.HTMLElement.prototype.getBoundingClientRect = function () { return new win.DOMRect(0, 0, width, 600) }
  ;({ createRoot } = await import("react-dom/client")); ({ EditorLayout } = await import("../components/image-combiner/editor-layout"))
})
after(async () => { browserHook.deregister(); await win.happyDOM.close(); for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name) } })
async function flush(action?: () => void) { await act(async () => { action?.(); await new Promise<void>(resolve => setImmediate(resolve)) }) }
function separator() { const value = win.document.querySelector('[role="separator"]'); assert.ok(value); return value }
function leftWidth() { return Number((win.document.querySelector('[data-panel-id="creation-input"]') as InstanceType<typeof win.HTMLElement> | null)?.style.flexGrow) }
async function key(value: string) { await flush(() => separator().dispatchEvent(new win.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }))) }
async function viewport(viewportWidth: number, containerWidth: number) { await flush(() => { width = containerWidth; win.happyDOM.setWindowSize({ width: viewportWidth, height: 900 }); for (const callback of observers) callback() }) }
async function mount(t: TestContext) {
  const container = win.document.createElement("div"); win.document.body.append(container)
  const root: Root = createRoot(container as unknown as HTMLElement)
  let unmounted = false
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); container.remove() } }
  t.after(async () => { await unmount(); win.localStorage.clear(); width = 1212; win.happyDOM.setWindowSize({ width: 1440, height: 900 }) })
  await act(async () => root.render(<EditorLayout input={<input aria-label="本轮草稿" defaultValue="保留输入" />} history={<p>版本历史</p>} preview={<p>原图和批注</p>} actions={<button>生成新版本</button>} />))
  await flush()
  return { unmount }
}

test("the actual splitter supports keyboard sizing, bounded widths, and reset", async t => {
  await mount(t)
  assert.equal(separator().getAttribute("aria-orientation"), "vertical")
  assert.equal(leftWidth(), 35)
  await key("ArrowRight"); assert.equal(leftWidth(), 40)
  assert.equal(JSON.parse(win.localStorage.getItem(storageKey)!), 40)
  await key("Home"); assert.equal(leftWidth(), 30)
  await key("End"); assert.ok((100 - leftWidth()) * 1200 / 100 >= 320)
  await key("Enter"); assert.equal(leftWidth(), 35)
  await key("ArrowRight")
  await flush(() => separator().dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true })))
  assert.equal(leftWidth(), 35)
  await viewport(1024, 800)
  assert.ok(leftWidth() * (800 - 12) / 100 >= 359.99)
  await key("End"); assert.ok((100 - leftWidth()) * (800 - 12) / 100 >= 319.99)
})

test("responsive changes keep the same editor and only one action, and remember the desktop ratio", async t => {
  const first = await mount(t)
  await key("ArrowRight")
  const field = win.document.querySelector("input")!; field.value = "正在输入的草稿"
  await viewport(800, 500)
  assert.equal(win.document.querySelector("[data-editor-layout]")?.getAttribute("data-editor-layout"), "rows")
  assert.equal(separator().getAttribute("tabindex"), "-1")
  assert.equal(win.document.querySelector("input"), field)
  assert.equal(win.document.querySelectorAll("input").length, 1)
  assert.equal(win.document.querySelectorAll("button").length, 1)
  assert.equal(JSON.parse(win.localStorage.getItem(storageKey)!), 40)
  await viewport(1440, 1212)
  assert.equal(leftWidth(), 40)
  assert.equal(win.document.querySelector("input"), field)
  assert.equal(field.value, "正在输入的草稿")
  await first.unmount()
  await mount(t)
  assert.equal(leftWidth(), 40)
})

test("passive desktop constraints preserve the preferred ratio across shrink, grow, and reload", async t => {
  const first = await mount(t)
  await key("ArrowRight")
  assert.equal(leftWidth(), 40)
  await viewport(1024, 800)
  assert.equal(leftWidth(), 45.7)
  assert.equal(JSON.parse(win.localStorage.getItem(storageKey)!), 40)
  await viewport(1440, 1212)
  assert.equal(leftWidth(), 40)
  await first.unmount()
  await mount(t)
  assert.equal(leftWidth(), 40)
})

test("corrupt or inaccessible local storage falls back without blocking the editor", async t => {
  win.localStorage.setItem(storageKey, '{"bad":true}')
  const first = await mount(t); assert.equal(leftWidth(), 35); await first.unmount()
  t.mock.method(win.localStorage, "getItem", () => { throw new Error("blocked") })
  t.mock.method(win.localStorage, "setItem", () => { throw new Error("blocked") })
  await mount(t); assert.equal(leftWidth(), 35)
  await key("ArrowRight"); assert.equal(leftWidth(), 40)
  await key("Enter"); assert.equal(leftWidth(), 35)
})
