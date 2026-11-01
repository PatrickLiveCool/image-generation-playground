import assert from "node:assert/strict"
import { after, before, test, type TestContext } from "node:test"
import { registerHooks } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { IDBFactory, IDBObjectStore } from "fake-indexeddb"
import { Window } from "happy-dom"
import { act } from "react"
import type { Root } from "react-dom/client"
import { addCreation, applyPrivateRun, emptyWorkspace, mergePrivateWorkspace, newCreation, patchCreationDraft, privateRunGeneration, startCreationGeneration, writeWorkspace, selectCreationVersion, markPrivateRunUnknown, accountStorageKey, EMERGENCY_DRAFT_KEY, emergencyDraftEntry, serializeEmergencyDrafts } from "../lib/creative-workspace"
import type { PrivateCreation, PrivateRun } from "../lib/private-workspace-types"
import { listPrivateWorkspace, requestPrivateRun } from "../lib/private-workspace-client"
import { ACCOUNT_SESSION_RECHECK_EVENT } from "../lib/account-client"
import { AccountVisibilityContext } from "../components/account/account-visibility"
import { useCreativeWorkspace } from "../components/image-combiner/hooks/use-creative-workspace"
import { useImageActions } from "../components/image-combiner/hooks/use-image-actions"

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
after(async () => { decoration.deregister(); await win.happyDOM.close(); for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name) } })
const cid = "11111111-1111-4111-8111-111111111111"
const rid = "22222222-2222-4222-8222-222222222222"
const asset = "/api/images/33333333-3333-4333-8333-333333333333"
const catalog = { revision: 4, configured: true, apiMode: "images", mappings: [{ id: "mapping-a", name: "共用模型", aspectRatios: ["square", "3:2"] }] }
function run(patch: Partial<PrivateRun> = {}): PrivateRun { return { id: rid, creationId: cid, creationRevision: 7, version: 1, parentVersionId: null, status: "complete", imageUrl: asset, prompt: "首版提示", mappingId: "mapping-a", modelLabel: "共用模型", aspectRatio: "3:2", quality: "high", mode: "text-to-image", createdAt: 100, updatedAt: 101, ...patch } }
function remote(versions: PrivateRun[] = [run()]): PrivateCreation { return { id: cid, title: "服务端创作", revision: 7, createdAt: 90, updatedAt: 110, versions } }
async function flush(action?: () => void) { await act(async () => { action?.(); await new Promise<void>(resolve => setImmediate(resolve)) }) }
async function eventually(check: () => void) { let failure: unknown; for (let i = 0; i < 100; i++) { try { await act(async () => { check() }); return } catch (error) { failure = error } await act(async () => { await delay(10) }) } throw failure }
function button(text: string) { const value = [...win.document.querySelectorAll("button")].find(item => item.textContent?.trim() === text); assert.ok(value, `Missing button ${text}`); return value }
function prompt() { const value = win.document.querySelector("textarea"); assert.ok(value); return value }
async function typePrompt(text: string) { await flush(() => { const field = prompt(); Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new win.Event("input", { bubbles: true })) }) }
async function mount(t: TestContext, account: string) {
  const container = win.document.createElement("div"); win.document.body.append(container); const root: Root = createRoot(container as unknown as HTMLElement)
  t.after(async () => { await act(async () => root.unmount()); await delay(25); container.remove(); win.localStorage.clear(); win.sessionStorage.clear(); win.document.body.style.pointerEvents = "" })
  await act(async () => root.render(<ImageCombiner accountId={account} />))
  await eventually(() => assert.ok(win.document.querySelector("textarea")))
  return root
}
function baseFetch(path: string) { if (path === "/api/version") return Response.json({ version: "development" }); if (path === "/api/models") return Response.json(catalog); return undefined }

test("remote merge discards local successful history, preserves same-creation drafts, and restores server parameters on a new device", () => {
  const local = newCreation({ prompt: "本地草稿" }, cid); local.versions = [{ ...privateRunGeneration(run()), imageUrl: "https://forged.invalid/x" }, privateRunGeneration(run({ id: "forged", version: 900 }))]; local.selectedVersionId = rid
  local.remoteRevision = 999
  const unrelated = newCreation({ prompt: "旧匿名内容" }, "legacy-local"); unrelated.versions = [privateRunGeneration(run())]
  const merged = mergePrivateWorkspace({ ...emptyWorkspace(), activeCreationId: cid, creations: [local, unrelated] }, [remote()])
  assert.equal(merged.creations.length, 1); assert.equal(merged.creations[0].draft.prompt, "本地草稿"); assert.equal(merged.creations[0].versions.length, 1)
  assert.equal(merged.creations[0].versions[0].imageUrl, asset); assert.equal(merged.creations[0].remoteRevision, 7)
  const fresh = mergePrivateWorkspace(emptyWorkspace(), [remote()]).creations[0]
  assert.equal(fresh.selectedVersionId, rid); assert.equal(fresh.draft.selectedMappingId, "mapping-a"); assert.equal(fresh.draft.aspectRatio, "3:2"); assert.equal(fresh.draft.quality, "high"); assert.equal(fresh.draft.prompt, "")
})

test("completion clears only the same submitted draft revision and unknown status leaves the base untouched", () => {
  const local = mergePrivateWorkspace(emptyWorkspace(), [remote()])
  let state = patchCreationDraft(local, cid, { prompt: "本轮提示" })
  const pending = { ...privateRunGeneration(run({ id: "new-run", status: "generating", imageUrl: null })), submittedDraftRevision: state.creations[0].draftRevision }
  state = startCreationGeneration(state, cid, pending)
  state = applyPrivateRun(state, run({ id: "new-run", status: "unknown", imageUrl: null, version: 2, parentVersionId: rid }))
  assert.equal(state.creations[0].selectedVersionId, rid); assert.equal(state.creations[0].draft.prompt, "本轮提示")
  const edited = patchCreationDraft(state, cid, { prompt: "新的未提交输入" })
  const result = applyPrivateRun(edited, run({ id: "new-run", version: 2, parentVersionId: rid }))
  assert.equal(result.creations[0].draft.prompt, "新的未提交输入"); assert.equal(result.creations[0].selectedVersionId, "new-run")
  const unchanged = applyPrivateRun(state, run({ id: "new-run", version: 2, parentVersionId: rid }))
  assert.equal(unchanged.creations[0].draft.prompt, "")
})

test("actual editor posts original parent and prompt, keeps another creation isolated, and accepts the server run response", async t => {
  const account = "private-ui-isolation"
  const second = run({ id: "44444444-4444-4444-8444-444444444444", version: 2, parentVersionId: rid, createdAt: 120 })
  const local = mergePrivateWorkspace(emptyWorkspace(), [remote([second, run()])]); local.creations[0].selectedVersionId = rid; local.creations[0].draft.prompt = "只改标题"; local.creations[0].draft.documentName = "恢复.txt"; local.creations[0].draft.documentText = "保留背景"
  await writeWorkspace(local, 0, "seed", account)
  let resolveRun: ((response: Response) => void) | undefined
  const requests: { path: string; init?: RequestInit }[] = []
  let submittedId = ""
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    requests.push({ path, init }); const common = baseFetch(path); if (common) return common
    if (path === "/api/creations" && init?.method === "POST") { const body = JSON.parse(String(init.body)); return Response.json({ creation: { ...remote([]), id: body.id, title: body.title } }) }
    if (path === "/api/creations") return Response.json({ creations: [remote([second, run()])] })
    if (path === "/api/generate-image") {
      const form = init!.body as FormData; submittedId = String(form.get("clientRequestId")); assert.equal(form.get("parentVersionId"), rid); assert.equal(form.get("prompt"), "只改标题"); assert.equal(form.get("documentText"), "保留背景"); assert.equal(form.has("baseImageUrl"), false); assert.equal(form.has("version"), false)
      return new Promise<Response>(resolve => { resolveRun = resolve })
    }
    throw new Error(`Unexpected offline request: ${path}`)
  })
  await mount(t, account)
  assert.ok(win.document.querySelector('[aria-label="选择 V1"][aria-pressed="true"]'))
  await flush(() => button("修改 V1").click()); await eventually(() => assert.ok(resolveRun))
  await flush(() => button("新建创作").click()); await eventually(() => assert.equal(prompt().value, ""))
  await typePrompt("另一创作输入")
  await flush(() => resolveRun!(Response.json({ run: run({ id: submittedId, version: 3, parentVersionId: rid }) })))
  assert.equal(prompt().value, "另一创作输入"); assert.equal(requests.filter(item => item.path === "/api/generate-image").length, 1)
  const select = win.document.querySelector("select#active-creation")! as InstanceType<typeof win.HTMLSelectElement>
  await flush(() => { select.value = cid; select.dispatchEvent(new win.Event("change", { bubbles: true })) })
  assert.equal(prompt().value, ""); assert.ok(win.document.querySelector('[aria-label="选择 V3"][aria-pressed="true"]'))
})

test("unknown generation exposes status and repair without another generation, preserving newer draft input", async t => {
  const account = "private-ui-unknown"; const local = mergePrivateWorkspace(emptyWorkspace(), [remote()]); local.creations[0].draft.prompt = "修改首版"; await writeWorkspace(local, 0, "seed", account)
  let requestId = ""; const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${path}`); const common = baseFetch(path); if (common) return common
    if (path === "/api/creations") return Response.json({ creations: [remote()] })
    if (path === "/api/generate-image") { requestId = String((init!.body as FormData).get("clientRequestId")); throw new TypeError("offline") }
    if (path === `/api/runs/${requestId}`) return Response.json({ run: run({ id: requestId, version: 2, parentVersionId: rid, status: "save_pending", imageUrl: null }) }, { status: 202 })
    if (path === `/api/runs/${requestId}/repair`) { assert.equal(init?.method, "POST"); assert.equal(init?.body, undefined); return Response.json({ run: run({ id: requestId, version: 2, parentVersionId: rid }) }) }
    throw new Error(`Unexpected offline request: ${path}`)
  })
  await mount(t, account); await flush(() => button("修改 V1").click()); await eventually(() => assert.ok(button("查看状态")))
  assert.equal(prompt().value, "修改首版"); assert.ok(win.document.querySelector('[aria-label="选择 V1"][aria-pressed="true"]'))
  await typePrompt("之后输入的新草稿"); await flush(() => button("查看状态").click()); assert.match(win.document.body.textContent, /等待补记保存/)
  await flush(() => button("仅补记保存").click()); assert.equal(prompt().value, "之后输入的新草稿"); assert.ok(win.document.querySelector('[aria-label="选择 V2"][aria-pressed="true"]'))
  assert.equal(calls.filter(path => path === "POST /api/generate-image").length, 1)
})

test("new account starts with a local editor and creates its server creation exactly before submit", async t => {
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${path}`); const common = baseFetch(path); if (common) return common
    if (path === "/api/creations" && init?.method === "POST") { const body = JSON.parse(String(init.body)); return Response.json({ creation: { ...remote([]), id: body.id, title: body.title } }) }
    if (path === "/api/creations") return Response.json({ creations: [] })
    if (path === "/api/generate-image") { const form = init!.body as FormData; return Response.json({ run: run({ id: String(form.get("clientRequestId")), creationId: String(form.get("creationId")), prompt: String(form.get("prompt")) }) }) }
    throw new Error(`Unexpected offline request: ${path}`)
  })
  await mount(t, "private-ui-first")
  assert.equal(calls.some(path => path.startsWith("POST")), false)
  await typePrompt("新作品")
  await flush(() => (win.document.querySelector('[aria-label="选择模型"]') as InstanceType<typeof win.HTMLButtonElement>).click())
  await flush(() => button("共用模型").click())
  await flush(() => button("生成图片").click())
  await eventually(() => assert.ok(win.document.querySelector('[aria-label="选择 V1"]')))
  assert.deepEqual(calls.filter(path => path.startsWith("POST")), ["POST /api/creations", "POST /api/generate-image"])
})

test("private image download and copy validate response and suppress late effects when account content becomes hidden", async t => {
  let actions: ReturnType<typeof useImageActions> | undefined; const toasts: string[] = []; let resolveFetch: ((value: Response) => void) | undefined; let downloads = 0; let copied = 0
  function Probe() { actions = useImageActions({ isMobile: false, currentMode: "text-to-image", onToast: message => toasts.push(message) }); return <span>actions</span> }
  const container = win.document.createElement("div"); win.document.body.append(container); const root = createRoot(container as unknown as HTMLElement)
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => { assert.equal(path, asset); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin"); return new Promise<Response>(resolve => { resolveFetch = resolve }) })
  t.mock.method(win.HTMLAnchorElement.prototype, "click", () => { downloads++ })
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async () => { copied++ } } })
  try {
    await act(async () => root.render(<AccountVisibilityContext.Provider value={true}><Probe /></AccountVisibilityContext.Provider>))
    const pending = actions!.downloadImage({ url: asset, prompt: "" }); await flush()
    await act(async () => root.render(<AccountVisibilityContext.Provider value={false}><Probe /></AccountVisibilityContext.Provider>))
    await flush(() => resolveFetch!(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }))); await pending
    assert.equal(downloads, 0); assert.equal(copied, 0)
    await act(async () => root.render(<AccountVisibilityContext.Provider value={true}><Probe /></AccountVisibilityContext.Provider>))
    const copy = actions!.copyImageToClipboard({ url: asset, prompt: "" }); await flush()
    await flush(() => win.dispatchEvent(new win.Event(ACCOUNT_SESSION_RECHECK_EVENT)))
    await flush(() => resolveFetch!(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }))); await copy
    assert.equal(copied, 0)
    const invalid = actions!.downloadImage({ url: asset, prompt: "" }); await flush(); await flush(() => resolveFetch!(new Response("login page", { headers: { "Content-Type": "text/html" } }))); await invalid
    assert.equal(downloads, 0); assert.ok(toasts.some(text => /图片访问失败/.test(text)))
  } finally { await act(async () => root.unmount()); container.remove() }
})

test("rename conflict uses the server revision and keeps the proposed name and draft available", async t => {
  const account = "private-ui-rename"; const local = mergePrivateWorkspace(emptyWorkspace(), [remote()]); local.creations[0].draft.prompt = "保留我的草稿"; await writeWorkspace(local, 0, "seed", account)
  let patchBody: unknown
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    const common = baseFetch(path); if (common) return common
    if (path === "/api/creations") return Response.json({ creations: [remote()] })
    if (path === `/api/creations/${cid}`) { assert.equal(init?.method, "PATCH"); patchBody = JSON.parse(String(init?.body)); return Response.json({ error: { code: "REVISION_CONFLICT", message: "版本冲突" } }, { status: 409 }) }
    throw new Error(`Unexpected offline request: ${path}`)
  })
  await mount(t, account)
  await flush(() => (win.document.querySelector('[aria-label="重命名当前创作"]') as InstanceType<typeof win.HTMLButtonElement>).click())
  await flush(() => { const field = win.document.querySelector("#creation-name")!; Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(field, "新的名称"); field.dispatchEvent(new win.Event("input", { bubbles: true })) })
  await flush(() => win.document.querySelector("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })))
  assert.deepEqual(patchBody, { revision: 7, title: "新的名称" })
  assert.match(win.document.body.textContent, /请刷新创作后重新命名/)
  assert.equal((win.document.querySelector("#creation-name") as InstanceType<typeof win.HTMLInputElement>).value, "新的名称")
  assert.equal(prompt().value, "保留我的草稿")
})

test("unknown creation POST is not repeated until an explicit refresh confirms its server state", async t => {
  const account = "private-ui-create-unknown"; const blank = { ...newCreation({ prompt: "先建创作", selectedMappingId: "mapping-a" }), localOnly: true }; await writeWorkspace(addCreation(emptyWorkspace(), blank), 0, "seed", account)
  let posted = false; const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${path}`); const common = baseFetch(path); if (common) return common
    if (path === "/api/creations" && init?.method === "POST") { posted = true; throw new TypeError("lost create response") }
    if (path === "/api/creations") return Response.json({ creations: posted ? [{ ...remote([]), id: blank.id }] : [] })
    if (path === "/api/generate-image") { const form = init!.body as FormData; return Response.json({ run: run({ id: String(form.get("clientRequestId")), creationId: blank.id }) }) }
    throw new Error(`Unexpected offline request: ${path}`)
  })
  await mount(t, account)
  await flush(() => button("生成图片").click()); await eventually(() => assert.match(win.document.body.textContent, /创作是否建立尚未确认/))
  await flush(() => button("生成图片").click()); assert.equal(calls.filter(item => item === "POST /api/creations").length, 1); assert.equal(calls.includes("POST /api/generate-image"), false)
  assert.equal(prompt().value, "先建创作")
  await flush(() => button("刷新创作").click()); await flush(() => button("生成图片").click())
  await eventually(() => assert.ok(win.document.querySelector('[aria-label="选择 V1"]')))
  assert.equal(calls.filter(item => item === "POST /api/creations").length, 1); assert.equal(calls.filter(item => item === "POST /api/generate-image").length, 1)
})

test("stopping the wait keeps an unknown task and ignores the late original response", async t => {
  const account = "private-ui-cancel"; const local = mergePrivateWorkspace(emptyWorkspace(), [remote()]); local.creations[0].draft.prompt = "保持可恢复"; await writeWorkspace(local, 0, "seed", account)
  let resolveRun: ((value: Response) => void) | undefined; let submitted = ""; let signal: AbortSignal | null | undefined
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    const common = baseFetch(path); if (common) return common
    if (path === "/api/creations") return Response.json({ creations: [remote()] })
    if (path === "/api/generate-image") { signal = init?.signal; submitted = String((init!.body as FormData).get("clientRequestId")); return new Promise<Response>(resolve => { resolveRun = resolve }) }
    throw new Error(`Unexpected offline request: ${path}`)
  })
  await mount(t, account); await flush(() => button("修改 V1").click()); await eventually(() => assert.ok(resolveRun))
  await flush(() => button("停止等待").click()); assert.equal(signal?.aborted, true)
  await flush(() => resolveRun!(Response.json({ run: run({ id: submitted, version: 2, parentVersionId: rid }) })))
  assert.equal(prompt().value, "保持可恢复"); assert.ok(button("查看状态")); assert.ok(win.document.querySelector('[aria-label="选择 V1"][aria-pressed="true"]')); assert.equal(win.document.querySelector('[aria-label="选择 V2"]'), null)
})

test("restored in-flight task uses bounded GET polling, then offers manual status without reposting", async t => {
  let reads = 0
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    const common = baseFetch(path); if (common) return common
    if (path === "/api/creations") return Response.json({ creations: [remote([run({ status: "generating", imageUrl: null })])] })
    if (path === `/api/runs/${rid}`) { reads++; assert.equal(init?.method, undefined); return Response.json({ run: run({ status: "generating", imageUrl: null }) }, { status: 202 }) }
    throw new Error(`Unexpected offline request: ${path}`)
  })
  await mount(t, "private-ui-poll")
  assert.equal(reads, 1)
  await act(async () => { await delay(10_300) })
  assert.equal(reads, 6)
  assert.ok(button("查看状态"))
  await act(async () => { await delay(200) })
  assert.equal(reads, 6)
})

test("unmount aborts a pending run status request without another generation", async t => {
  let querySignal: AbortSignal | null | undefined
  let resolveQuery: ((value: Response) => void) | undefined
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    const common = baseFetch(path); if (common) return common
    if (path === "/api/creations") return Response.json({ creations: [remote([run({ status: "generating", imageUrl: null })])] })
    if (path === `/api/runs/${rid}`) { querySignal = init?.signal; return new Promise<Response>(resolve => { resolveQuery = resolve }) }
    throw new Error(`Unexpected offline request: ${path}`)
  })
  const root = await mount(t, "private-ui-unmount")
  await eventually(() => assert.ok(resolveQuery))
  await act(async () => root.unmount())
  assert.equal(querySignal?.aborted, true)
  await flush(() => resolveQuery!(Response.json({ run: run() })))
  assert.equal(win.document.querySelector('[aria-label="选择 V1"]'), null)
})


test("private API session failure dispatches a session recheck rather than accepting stale data", async t => {
  let rechecks = 0
  const listener = () => { rechecks++ }
  win.addEventListener(ACCOUNT_SESSION_RECHECK_EVENT, listener)
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "PASSWORD_CHANGE_REQUIRED", message: "请先修改密码" } }, { status: 403 }))
  try { await assert.rejects(listPrivateWorkspace(), /请先修改密码/); assert.equal(rechecks, 1) }
  finally { win.removeEventListener(ACCOUNT_SESSION_RECHECK_EVENT, listener) }
})

test("explicit new creation preserves an occupied first draft and opens a separate empty editor", async t => {
  const account = "private-ui-new-draft"; const blank = { ...newCreation({ prompt: "第一份未提交草稿", selectedMappingId: "mapping-a" }), localOnly: true }; await writeWorkspace(addCreation(emptyWorkspace(), blank), 0, "seed", account)
  const created: string[] = []
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    const common = baseFetch(path); if (common) return common
    if (path === "/api/creations" && init?.method === "POST") { const body = JSON.parse(String(init.body)); created.push(body.id); return Response.json({ creation: { ...remote([]), id: body.id } }) }
    if (path === "/api/creations") return Response.json({ creations: [] })
    throw new Error(`Unexpected offline request: ${path}`)
  })
  await mount(t, account); await flush(() => button("新建创作").click())
  await eventually(() => assert.equal(created.length, 2))
  assert.equal(created[0], blank.id); assert.notEqual(created[1], blank.id); assert.equal(prompt().value, "")
  const select = win.document.querySelector("select#active-creation")! as InstanceType<typeof win.HTMLSelectElement>
  await flush(() => { select.value = blank.id; select.dispatchEvent(new win.Event("change", { bubbles: true })) })
  assert.equal(prompt().value, "第一份未提交草稿")
})

async function mountWorkspaceHook(t: TestContext, account: string) {
  let latest: ReturnType<typeof useCreativeWorkspace> | undefined
  function Probe() { latest = useCreativeWorkspace(account); return <span>{latest.activeCreation?.draft.prompt}</span> }
  const container = win.document.createElement("div"); win.document.body.append(container)
  const root = createRoot(container as unknown as HTMLElement)
  t.after(async () => { await act(async () => root.unmount()); await delay(25); container.remove() })
  await act(async () => root.render(<Probe />))
  await eventually(() => assert.equal(latest?.ready, true))
  return { current: () => latest!, unmount: async () => { await act(async () => root.unmount()); await delay(25); container.remove() } }
}

test("live hook syncs completed creationRevision so immediate rename succeeds and stale snapshots cannot downgrade it", async t => {
  const account = "review-revision"; let getCount = 0; let resolveOld: ((response: Response) => void) | undefined; let patchBody: unknown
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/creations") { if (++getCount === 1) return Response.json({ creations: [remote()] }); return new Promise<Response>(resolve => { resolveOld = resolve }) }
    if (path === `/api/creations/${cid}`) { patchBody = JSON.parse(String(init?.body)); assert.deepEqual(patchBody, { revision: 9, title: "生成后立即改名" }); return Response.json({ creation: { ...remote([run({ creationRevision: 10, version: 2 })]), title: "生成后立即改名", revision: 10 } }) }
    throw new Error(`Unexpected request: ${path}`)
  })
  const hook = await mountWorkspaceHook(t, account)
  let refresh: Promise<void> | undefined
  await flush(() => { refresh = hook.current().refresh() })
  await flush(() => hook.current().applyRun(run({ creationRevision: 9, version: 2 })))
  assert.equal(hook.current().activeCreation?.remoteRevision, 9)
  await act(async () => { await hook.current().renameCreation(cid, "生成后立即改名") })
  await flush(() => resolveOld!(Response.json({ creations: [remote([run({ status: "generating", imageUrl: null })])] }))); await refresh
  assert.equal(hook.current().activeCreation?.remoteRevision, 10)
  assert.equal(hook.current().activeCreation?.versions[0].status, "complete")
  assert.equal(hook.current().activeCreation?.title, "生成后立即改名")
  // A subsequently delivered old run still cannot lower the revision or completed state.
  await flush(() => hook.current().applyRun(run({ creationRevision: 8, status: "generating", imageUrl: null })))
  assert.equal(hook.current().activeCreation?.remoteRevision, 10)
  assert.equal(hook.current().activeCreation?.versions[0].status, "complete")
  assert.equal(getCount, 2)
})

test("live refresh preserves a creation and draft added while the old list is in flight", async t => {
  let initial = true; let resolveOld: ((response: Response) => void) | undefined
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    assert.equal(path, "/api/creations")
    if (init?.method === "POST") { const body = JSON.parse(String(init.body)); return Response.json({ creation: { ...remote([]), id: body.id, title: body.title } }) }
    if (initial) { initial = false; return Response.json({ creations: [remote()] }) }
    return new Promise<Response>(resolve => { resolveOld = resolve })
  })
  const hook = await mountWorkspaceHook(t, "review-refresh-new")
  let refresh: Promise<void> | undefined; let id = ""
  await flush(() => { refresh = hook.current().refresh() })
  await act(async () => { id = await hook.current().createCreation() })
  await flush(() => hook.current().patchDraft(id, { prompt: "刷新期间新创作的文字" }))
  await flush(() => resolveOld!(Response.json({ creations: [remote()] }))); await refresh
  assert.equal(hook.current().activeCreationId, id)
  assert.equal(hook.current().getCreation(id)?.draft.prompt, "刷新期间新创作的文字")
  assert.equal(hook.current().creations.length, 2)
})

test("overlapping refreshes accept only the newest response, while progress does not invalidate a refresh", async t => {
  const replies: Array<(response: Response) => void> = []; let initial = true
  t.mock.method(globalThis, "fetch", async () => {
    if (initial) { initial = false; return Response.json({ creations: [remote()] }) }
    return new Promise<Response>(resolve => replies.push(resolve))
  })
  const hook = await mountWorkspaceHook(t, "review-refresh-sequence")
  await flush(() => hook.current().startGeneration(cid, { ...privateRunGeneration(run({ id: "pending-review", status: "generating", imageUrl: null })), submittedDraftRevision: 0 }))
  let first: Promise<void> | undefined; let second: Promise<void> | undefined
  await flush(() => { first = hook.current().refresh(); second = hook.current().refresh() })
  await flush(() => hook.current().updateGeneration(cid, "pending-review", { progress: 90 }))
  await flush(() => replies[1](Response.json({ creations: [{ ...remote(), title: "最新列表", revision: 9 }] }))); await second
  await flush(() => replies[0](Response.json({ creations: [{ ...remote(), title: "旧列表", revision: 8 }] }))); await first
  assert.equal(hook.current().activeCreation?.title, "最新列表")
  assert.equal(hook.current().activeCreation?.remoteRevision, 9)
  assert.equal(replies.length, 2)
})

test("changing to an old base with the same ratio preserves input and selection after a stopped run completes", () => {
  const older = run(); const newer = run({ id: "newer-base", version: 2, createdAt: 120 })
  let state = mergePrivateWorkspace(emptyWorkspace(), [remote([newer, older])])
  state = patchCreationDraft(state, cid, { prompt: "保持这份修改草稿" })
  state = startCreationGeneration(state, cid, { ...privateRunGeneration(run({ id: "stopped", status: "generating", imageUrl: null })), submittedDraftRevision: state.creations[0].draftRevision })
  state = markPrivateRunUnknown(state, cid, "stopped", "已停止等待")
  const revision = state.creations[0].draftRevision
  state = selectCreationVersion(state, cid, rid)
  assert.equal(state.creations[0].draftRevision, revision + 1)
  state = applyPrivateRun(state, run({ id: "stopped", parentVersionId: "newer-base", version: 3, creationRevision: 9 }))
  assert.equal(state.creations[0].selectedVersionId, rid)
  assert.equal(state.creations[0].draft.prompt, "保持这份修改草稿")
})

test("status or repair errors preserve save_pending and failed facts while recording an actionable error", () => {
  for (const status of ["save_pending", "failed"] as const) {
    const state = mergePrivateWorkspace(emptyWorkspace(), [remote([run({ status, imageUrl: null })])])
    const changed = markPrivateRunUnknown(state, cid, rid, "查询暂时失败，请稍后查看状态")
    assert.equal(changed.creations[0].versions[0].runStatus, status)
    assert.equal(changed.creations[0].versions[0].error, "查询暂时失败，请稍后查看状态")
  }
})

test("recovered emergency text survives a real IDB write failure and another hook hydration", async t => {
  const account = "review-emergency-failure"
  const canonical = mergePrivateWorkspace(emptyWorkspace(), [remote()]); await writeWorkspace(canonical, 0, "seed", account)
  const changed = patchCreationDraft(canonical, cid, { prompt: "应急文字不能被提前清除" })
  const key = accountStorageKey(EMERGENCY_DRAFT_KEY, account)
  sessionStorage.setItem(key, serializeEmergencyDrafts(1, null, [emergencyDraftEntry(changed.creations[0], canonical.creations[0])], cid))
  t.mock.method(globalThis, "fetch", async () => Response.json({ creations: [remote()] }))
  t.mock.method(IDBObjectStore.prototype, "put", () => { throw new DOMException("disk full", "QuotaExceededError") })
  const first = await mountWorkspaceHook(t, account)
  await eventually(() => assert.match(first.current().storageError ?? "", /暂时无法保存/))
  assert.match(sessionStorage.getItem(key) ?? "", /应急文字不能被提前清除/)
  await first.unmount()
  assert.match(sessionStorage.getItem(key) ?? "", /应急文字不能被提前清除/)
  const next = await mountWorkspaceHook(t, account)
  assert.equal(next.current().activeCreation?.draft.prompt, "应急文字不能被提前清除")
  await eventually(() => assert.match(next.current().storageError ?? "", /暂时无法保存/))
  assert.match(sessionStorage.getItem(key) ?? "", /应急文字不能被提前清除/)
})

test("first submit names the creation from the first prompt line and keeps explicitly blank names", async t => {
  const account = "review-auto-name"
  const blank = { ...newCreation({ prompt: "第一段标题\n后续描述", selectedMappingId: "mapping-a" }), localOnly: true }
  await writeWorkspace(addCreation(emptyWorkspace(), blank), 0, "seed", account)
  const titles: string[] = []
  t.mock.method(globalThis, "fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/creations" && init?.method === "POST") { const body = JSON.parse(String(init.body)); titles.push(body.title); return Response.json({ creation: { ...remote([]), id: body.id, title: body.title } }) }
    return Response.json({ creations: [] })
  })
  const hook = await mountWorkspaceHook(t, account)
  await act(async () => { await hook.current().ensureRemoteCreation(blank.id, blank.draft.prompt) })
  assert.equal(hook.current().activeCreation?.title, "第一段标题")
  await act(async () => { await hook.current().createCreation() })
  assert.deepEqual(titles, ["第一段标题", "未命名创作"])
})

test("repair waits past 120 seconds, remains cancellable, and never retries its POST", async t => {
  let calls = 0; let signal: AbortSignal | null | undefined
  t.mock.method(globalThis, "fetch", async (_path: string, init?: RequestInit) => {
    calls++; signal = init?.signal
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))
  })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const request = requestPrivateRun(rid, { repair: true })
    t.mock.timers.tick(120_000); assert.equal(signal?.aborted, false)
    t.mock.timers.tick(5_000); await assert.rejects(request, /结果尚未确认/); assert.equal(calls, 1)
    const controller = new AbortController(); const cancelled = requestPrivateRun(rid, { repair: true, signal: controller.signal })
    controller.abort(); await assert.rejects(cancelled, /结果尚未确认/); assert.equal(calls, 2)
  } finally { t.mock.timers.reset() }
})

test("run responses without a valid creation revision are not accepted", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ run: { ...run(), creationRevision: undefined } }))
  await assert.rejects(requestPrivateRun(rid), /服务器结果尚未确认/)
})

test("bounded failure codes produce safe actionable messages, while unknown tasks still warn against reposting", () => {
  const cases = { BASE_VERSION_UNAVAILABLE: /基准版本.*重新选择/, REFERENCE_INVALID: /参考图片.*重新选择/, ACCOUNT_UNAVAILABLE: /账号.*登录/, MODEL_OUTPUT_INVALID: /有效图片.*配置/, PROVIDER_AUTH_REJECTED: /认证.*管理员/, PROVIDER_REQUEST_REJECTED: /拒绝.*输入/, PROVIDER_RATE_LIMITED: /限流.*查看/, PROVIDER_UPSTREAM_FAILED: /服务.*查看.*重复/, INPUT_READ_FAILED: /输入.*重新选择/, INPUT_SAVE_FAILED: /保存.*查看/ }
  for (const [failureCode, expected] of Object.entries(cases)) assert.match(privateRunGeneration(run({ status: "failed", imageUrl: null, failureCode })).error ?? "", expected)
  assert.match(privateRunGeneration(run({ status: "unknown", imageUrl: null, failureCode: "INPUT_SAVE_FAILED" })).error ?? "", /不要重复提交/)
})


test("refresh completion of the first submitted image clears only the matching emergency draft", () => {
  const blank = { ...newCreation({ prompt: "首图输入" }, cid), remoteRevision: 1 }
  let state = addCreation(emptyWorkspace(), blank)
  state = startCreationGeneration(state, cid, { ...privateRunGeneration(run({ status: "generating", imageUrl: null, creationRevision: 2 })), submittedDraftRevision: 0 })
  const merged = mergePrivateWorkspace(state, [{ ...remote([run({ creationRevision: 3 })]), revision: 3 }], { preserveConfirmed: true })
  assert.equal(merged.creations[0].draft.prompt, "")
  assert.equal(merged.creations[0].selectedVersionId, rid)
  const edited = patchCreationDraft(state, cid, { prompt: "更新输入" })
  assert.equal(mergePrivateWorkspace(edited, [remote()], { preserveConfirmed: true }).creations[0].draft.prompt, "更新输入")
})

test("first submission preserves an explicitly named local creation", async t => {
  const account = "review-custom-name"; const blank = { ...newCreation({ prompt: "不能覆盖名称" }, cid), title: "我的自定义名称", localOnly: true }
  await writeWorkspace(addCreation(emptyWorkspace(), blank), 0, "seed", account)
  t.mock.method(globalThis, "fetch", async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") { const body = JSON.parse(String(init.body)); assert.equal(body.title, "我的自定义名称"); return Response.json({ creation: { ...remote([]), title: body.title } }) }
    return Response.json({ creations: [] })
  })
  const hook = await mountWorkspaceHook(t, account)
  await act(async () => { await hook.current().ensureRemoteCreation(cid, blank.draft.prompt) })
  assert.equal(hook.current().activeCreation?.title, "我的自定义名称")
})


test("emergency draft recovers against the authenticated server base when no IDB snapshot ever succeeded", async t => {
  const account = "review-first-snapshot-failed"; const key = accountStorageKey(EMERGENCY_DRAFT_KEY, account)
  t.mock.method(globalThis, "fetch", async () => Response.json({ creations: [remote()] }))
  t.mock.method(IDBObjectStore.prototype, "put", () => { throw new DOMException("disk full", "QuotaExceededError") })
  const first = await mountWorkspaceHook(t, account)
  await flush(() => first.current().patchDraft(cid, { prompt: "首次设备未落盘的文字" }))
  assert.match(sessionStorage.getItem(key) ?? "", /首次设备未落盘的文字/)
  await first.unmount()
  const restored = await mountWorkspaceHook(t, account)
  assert.equal(restored.current().activeCreation?.draft.prompt, "首次设备未落盘的文字")
  assert.equal(restored.current().activeCreation?.selectedVersionId, rid)
  assert.match(sessionStorage.getItem(key) ?? "", /首次设备未落盘的文字/)
})
