import assert from "node:assert/strict"
import { after, before, test, type TestContext } from "node:test"
import { Window } from "happy-dom"
import { act } from "react"
import { AccountVisibilityContext } from "../components/account/account-visibility"
import { CreationHistory } from "../components/image-combiner/creation-history"
import { useImageActions } from "../components/image-combiner/hooks/use-image-actions"
import { ACCOUNT_SESSION_RECHECK_EVENT } from "../lib/account-client"
import type { Generation } from "../components/image-combiner/types"

const win = new Window({ url: "http://localhost:3000" })
const originals = new Map<string, PropertyDescriptor | undefined>()
let createRoot: typeof import("react-dom/client").createRoot
before(async () => {
  const globals: Record<string, unknown> = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: win.getComputedStyle.bind(win) }
  for (const key of ["HTMLElement", "Element", "Node", "Event", "MouseEvent"] as const) globals[key] = win[key]
  for (const [name, value] of Object.entries(globals)) { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }) }
  ;({ createRoot } = await import("react-dom/client"))
})
after(async () => { await win.happyDOM.close(); for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name) } })
const imagePath = "/api/images/33333333-3333-4333-8333-333333333333"
const savedDocument = { assetId: "44444444-4444-4444-8444-444444444444", name: "跨设备恢复.pdf" }
const documentPath = `/api/documents/${savedDocument.assetId}`
const generation: Generation = { id: "version-1", status: "complete", progress: 100, imageUrl: imagePath, prompt: "提示", timestamp: 1, document: savedDocument }
async function flush(action?: () => void) { await act(async () => { action?.(); await new Promise<void>(resolve => setImmediate(resolve)) }) }
function popup() {
  const navigations: string[] = []
  return { closed: false, opener: {} as unknown, document: { title: "" }, location: { replace(url: string) { navigations.push(url) } }, navigations, close() { this.closed = true } }
}
async function mount(t: TestContext) {
  let actions: ReturnType<typeof useImageActions> | undefined
  const toasts: string[] = []
  const created: string[] = []; const revoked: string[] = []; const downloads: { href: string; name: string }[] = []
  t.mock.method(URL, "createObjectURL", () => { const url = `blob:private-test-${created.length}`; created.push(url); return url })
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url) })
  t.mock.method(win.HTMLAnchorElement.prototype, "click", function (this: InstanceType<typeof win.HTMLAnchorElement>) { downloads.push({ href: this.href, name: this.download }) })
  function Probe() {
    actions = useImageActions({ currentMode: "text-to-image", isMobile: false, onToast: message => toasts.push(message) })
    return <CreationHistory generations={[generation]} selectedId={generation.id} pending={false} onSelect={() => {}} onCancel={() => {}} onDownloadDocument={document => void actions!.downloadDocument(document)} />
  }
  const container = win.document.createElement("div"); win.document.body.append(container)
  const root = createRoot(container as unknown as HTMLElement)
  const render = async (visible: boolean) => { await act(async () => root.render(<AccountVisibilityContext.Provider value={visible}><Probe /></AccountVisibilityContext.Provider>)) }
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  await render(true)
  return { actions: () => actions!, root, render, toasts, created, revoked, downloads }
}
const imageResponse = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } })
const documentResponse = () => new Response("%PDF-synthetic", { headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=document" } })

test("opening a private image opens its blank window synchronously, then fills it only after authenticated fetch", async t => {
  const view = await mount(t); const opened = popup(); const order: string[] = []
  let respond: ((value: Response) => void) | undefined
  t.mock.method(win, "open", (url: string, target: string) => { assert.equal(url, "about:blank"); assert.equal(target, "_blank"); order.push("open"); return opened as unknown as ReturnType<typeof win.open> })
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    order.push("fetch"); assert.equal(opened.opener, null); assert.equal(path, imagePath); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin")
    return new Promise<Response>(resolve => { respond = resolve })
  })
  const result = view.actions().openImageInNewTab({ url: imagePath, prompt: "" })
  assert.deepEqual(order, ["open", "fetch"]); assert.deepEqual(opened.navigations, []); assert.equal(opened.document.title, "正在读取图片…")
  respond!(imageResponse()); await result
  assert.deepEqual(opened.navigations, [view.created[0]]); assert.equal(opened.closed, false)
  await act(async () => view.root.unmount())
  assert.equal(opened.closed, true); assert.deepEqual(view.revoked, view.created)
})

test("popup blocking reports an actionable message without fetching a private image", async t => {
  const view = await mount(t); let fetched = false
  t.mock.method(win, "open", () => null)
  t.mock.method(globalThis, "fetch", async () => { fetched = true; throw new Error("must not fetch") })
  await view.actions().openImageInNewTab({ url: imagePath, prompt: "" })
  assert.equal(fetched, false); assert.match(view.toasts.join(" "), /浏览器阻止.*使用下载/)
})

test("a failed image fetch closes the placeholder window and reports the failure", async t => {
  const view = await mount(t); const opened = popup()
  t.mock.method(win, "open", () => opened as unknown as ReturnType<typeof win.open>)
  t.mock.method(globalThis, "fetch", async () => new Response("missing", { status: 404 }))
  await view.actions().openImageInNewTab({ url: imagePath, prompt: "" })
  assert.equal(opened.closed, true); assert.deepEqual(opened.navigations, []); assert.match(view.toasts.join(" "), /图片访问失败/)
})

test("hiding the account closes a pending popup, aborts fetch, and never fills it with a late private image", async t => {
  const view = await mount(t); const opened = popup(); let respond: ((value: Response) => void) | undefined; let signal: AbortSignal | null | undefined
  t.mock.method(win, "open", () => opened as unknown as ReturnType<typeof win.open>)
  t.mock.method(globalThis, "fetch", async (_path: string, init?: RequestInit) => { signal = init?.signal; return new Promise<Response>(resolve => { respond = resolve }) })
  const result = view.actions().openImageInNewTab({ url: imagePath, prompt: "" })
  await view.render(false)
  assert.equal(opened.closed, true); assert.equal(signal?.aborted, true)
  respond!(imageResponse()); await result
  assert.deepEqual(opened.navigations, []); assert.deepEqual(view.created, [])
})

test("history offers protected document download and releases the resulting object URL", async t => {
  const view = await mount(t); const paths: string[] = []
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    paths.push(path); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin"); return documentResponse()
  })
  const button = [...win.document.querySelectorAll("button")].find(element => element.textContent === `下载文档：${savedDocument.name}`)
  assert.ok(button)
  await flush(() => button.click())
  assert.deepEqual(paths, [documentPath]); assert.deepEqual(view.downloads, [{ href: view.created[0], name: savedDocument.name }]); assert.deepEqual(view.revoked, view.created)
})

test("document download rejects unauthenticated responses and requests a session recheck", async t => {
  const view = await mount(t); let rechecks = 0
  const listener = () => { rechecks++ }; win.addEventListener(ACCOUNT_SESSION_RECHECK_EVENT, listener)
  t.after(() => win.removeEventListener(ACCOUNT_SESSION_RECHECK_EVENT, listener))
  t.mock.method(globalThis, "fetch", async () => new Response("login", { status: 401, headers: { "Content-Type": "text/html" } }))
  await view.actions().downloadDocument(savedDocument)
  assert.equal(rechecks, 1); assert.deepEqual(view.downloads, []); assert.deepEqual(view.created, [])
})

test("document download rejects login-like successful pages and suppresses pending downloads after account hiding", async t => {
  const view = await mount(t)
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("login", { headers: { "Content-Type": "text/html" } }))
  await view.actions().downloadDocument(savedDocument)
  assert.deepEqual(view.downloads, []); assert.match(view.toasts.join(" "), /文档访问失败/)
  let respond: ((value: Response) => void) | undefined; let signal: AbortSignal | null | undefined
  mock.mock.mockImplementation(async (_path: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal; return new Promise<Response>(resolve => { respond = resolve }) })
  const pending = view.actions().downloadDocument(savedDocument)
  await view.render(false); assert.equal(signal?.aborted, true)
  respond!(documentResponse()); await pending
  assert.deepEqual(view.downloads, []); assert.deepEqual(view.created, [])
  const before = mock.mock.callCount()
  await view.actions().downloadDocument(savedDocument)
  assert.equal(mock.mock.callCount(), before)
})

test("opening the preview may hide its source tab without cancelling the explicitly requested window", async t => {
  const view = await mount(t); const opened = popup(); let respond: ((value: Response) => void) | undefined; let signal: AbortSignal | null | undefined
  const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState")
  t.mock.method(win, "open", () => opened as unknown as ReturnType<typeof win.open>)
  t.mock.method(globalThis, "fetch", async (_path: string, init?: RequestInit) => { signal = init?.signal; return new Promise<Response>(resolve => { respond = resolve }) })
  try {
    const result = view.actions().openImageInNewTab({ url: imagePath, prompt: "" })
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    await flush(() => document.dispatchEvent(new win.Event("visibilitychange") as unknown as Event))
    assert.equal(signal?.aborted, false); assert.equal(opened.closed, false)
    respond!(imageResponse()); await result
    assert.equal(opened.navigations.length, 1)
    await view.render(false); assert.equal(opened.closed, true)
  } finally {
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility)
    else Reflect.deleteProperty(document, "visibilityState")
  }
})

test("download stays cancelled when the source page hides then becomes visible before its response arrives", async t => {
  const view = await mount(t); let respond: ((value: Response) => void) | undefined; let signal: AbortSignal | null | undefined
  const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState")
  t.mock.method(globalThis, "fetch", async (_path: string, init?: RequestInit) => { signal = init?.signal; return new Promise<Response>(resolve => { respond = resolve }) })
  try {
    const result = view.actions().downloadDocument(savedDocument)
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    await flush(() => document.dispatchEvent(new win.Event("visibilitychange") as unknown as Event))
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    assert.equal(signal?.aborted, true)
    respond!(documentResponse()); await result
    assert.deepEqual(view.downloads, [])
  } finally {
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility)
    else Reflect.deleteProperty(document, "visibilityState")
  }
})
