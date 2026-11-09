import assert from "node:assert/strict"
import { before, after, test, type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { act } from "react"
import { Window } from "happy-dom"
import { IDBFactory } from "fake-indexeddb"
import type { Root } from "react-dom/client"
import { useCreativeWorkspace, type CreativeWorkspaceController } from "../components/image-combiner/hooks/use-creative-workspace"
import { accountStorageKey, EMERGENCY_DRAFT_KEY, emptyWorkspace, mergePrivateWorkspace, newCreation, removeDeletedCreations, recoverEmergencyDrafts, emergencyDraftEntry, serializeEmergencyDrafts, writeWorkspace, readWorkspace, restoreWorkspace } from "../lib/creative-workspace"
import type { PrivateCreation, PrivateDeletedCreation, PrivateRun } from "../lib/private-workspace-types"

const win = new Window({ url: "http://localhost:3000" })
const originals = new Map<string, PropertyDescriptor | undefined>()
let createRoot: typeof import("react-dom/client").createRoot
let CreationList: typeof import("../components/image-combiner/creation-list").CreationList
before(async () => {
  const globals: Record<string, unknown> = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, sessionStorage: win.sessionStorage,
    indexedDB: new IDBFactory(), IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win) }
  for (const name of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "ResizeObserver", "CustomEvent", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent"] as const) globals[name] = win[name]
  for (const [name, value] of Object.entries(globals)) { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }) }
  ;({ createRoot } = await import("react-dom/client"))
  ;({ CreationList } = await import("../components/image-combiner/creation-list"))
})
after(async () => { await win.happyDOM.close(); for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name) } })
const cid = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222"
const run: PrivateRun = { id: "33333333-3333-4333-8333-333333333333", creationId: cid, creationRevision: 7, version: 1, parentVersionId: null, status: "complete", imageUrl: "/api/images/44444444-4444-4444-8444-444444444444", prompt: "已保存要求", annotationSnapshot: null, mappingId: "model", modelLabel: "合成模型", aspectRatio: "square", quality: "auto", mode: "text-to-image", createdAt: 100, updatedAt: 101 }
function creation(id = cid): PrivateCreation { return { id, title: id === cid ? "主要创作" : "另一项创作", revision: 7, createdAt: 90, updatedAt: 110, versions: id === cid ? [run] : [] } }
async function flush(action?: () => unknown) { await act(async () => { await action?.(); await new Promise<void>(resolve => setImmediate(resolve)) }) }
async function eventually(check: () => void | Promise<void>) { let failure: unknown; for (let i = 0; i < 100; i++) { try { await act(async () => { await check() }); return } catch (error) { failure = error } await flush(() => delay(10)) } throw failure }
function fixture(t: TestContext, initial: PrivateCreation[] = [creation()]) {
  const state = { active: initial, deleted: [] as PrivateDeletedCreation[], writes: [] as string[], loseDelete: false, loseRestore: false, rejectDelete: false }
  t.mock.method(globalThis, "fetch", async (path: string, options?: RequestInit) => {
    const method = options?.method ?? "GET"
    if (path === "/api/creations" && method === "GET") return Response.json({ creations: state.active, deletedCreations: state.deleted })
    state.writes.push(method)
    if (path === "/api/creations" && method === "POST") {
      const body = JSON.parse(String(options?.body)); const remote = { ...creation(body.id), title: body.title, revision: 1, versions: [] }
      state.active.push(remote); return Response.json({ creation: remote })
    }
    const id = path.split("/")[3]
    const revision = JSON.parse(String(options?.body)).revision
    if (method === "DELETE") {
      if (state.rejectDelete) return Response.json({ error: { code: "CONFLICT", message: "创作已变化，请刷新。" } }, { status: 409 })
      const current = state.active.find(item => item.id === id)!; assert.equal(revision, current.revision)
      if (current.versions.some(run => !["complete", "failed"].includes(run.status))) return Response.json({ error: { code: "CREATION_HAS_PENDING_RUNS", message: "请先处理结果未知的任务。" } }, { status: 409 })
      state.active = state.active.filter(item => item.id !== id)
      const deletion = { id, revision: revision + 1, deletedAt: 200 }; state.deleted.push(deletion)
      if (state.loseDelete) throw new Error("Lost receipt")
      return Response.json({ deletion })
    }
    if (method === "POST" && path.endsWith("/restore")) {
      const deletion = state.deleted.find(item => item.id === id)!; assert.equal(revision, deletion.revision)
      state.deleted = state.deleted.filter(item => item.id !== id)
      const restored = { ...creation(id), revision: revision + 1 }; state.active.push(restored)
      if (state.loseRestore) throw new Error("Lost restore receipt")
      return Response.json({ creation: restored })
    }
    throw new Error(`Unexpected synthetic request: ${method} ${path}`)
  })
  return state
}
async function mount(t: TestContext, account: string, hasPendingInput?: (id: string) => boolean) {
  let controller: CreativeWorkspaceController
  function Harness() { controller = useCreativeWorkspace(account, hasPendingInput); return null }
  const container = win.document.createElement("div"); win.document.body.append(container)
  const root: Root = createRoot(container as unknown as HTMLElement)
  t.after(async () => { await flush(() => root.unmount()); await flush(() => delay(20)); container.remove(); win.sessionStorage.clear(); win.document.body.style.pointerEvents = "" })
  await flush(() => root.render(<Harness />)); await eventually(() => assert.ok(controller!.ready))
  return () => controller!
}

test("server tombstones remove stale local-only and emergency copies despite forged local revision", () => {
  const local = { ...newCreation({ prompt: "本机输入" }, cid), localOnly: true, remoteRevision: 999 }
  const state = { ...emptyWorkspace(), creations: [local], activeCreationId: cid }
  const deleted = [{ id: cid, revision: 8, deletedAt: 200 }]
  assert.equal(removeDeletedCreations(state, deleted).creations.length, 0)
  const raw = serializeEmergencyDrafts(0, null, [emergencyDraftEntry(local)])
  const recovery = recoverEmergencyDrafts(emptyWorkspace(), raw, [], deleted)
  assert.equal(mergePrivateWorkspace(recovery.workspace, [], { deletedCreations: deleted }).creations.length, 0)
})

test("delete selects the neighbour, persists removal, and undo restores versions and device-local drafts", async t => {
  const account = "lifecycle-delete-undo", service = fixture(t, [creation(), creation(otherId)])
  const seed = mergePrivateWorkspace(emptyWorkspace(), service.active)
  seed.creations[0].draft.prompt = "未提交草稿"; seed.creations[0].draft.image1 = new File(["synthetic"], "reference.png", { type: "image/png" })
  await writeWorkspace(seed, 0, "seed", account)
  const view = await mount(t, account)
  await flush(() => view().deleteCreation(cid))
  assert.equal(view().activeCreationId, otherId); assert.equal(view().creations.length, 1); assert.equal(view().deletions[0].state, "deleted")
  await eventually(async () => assert.equal(restoreWorkspace(await readWorkspace(account)).creations.some(item => item.id === cid), false))
  const emergency = win.sessionStorage.getItem(accountStorageKey(EMERGENCY_DRAFT_KEY, account))
  assert.equal(emergency?.includes(cid) ?? false, false)
  await flush(() => view().restoreCreation(cid))
  assert.equal(view().activeCreationId, cid); assert.equal(view().activeCreation?.draft.prompt, "未提交草稿")
  assert.equal(await view().activeCreation?.draft.image1?.text(), "synthetic")
  assert.equal(view().activeCreation?.versions[0].imageUrl, run.imageUrl); assert.equal(view().deletions.length, 0)
  assert.deepEqual(service.writes, ["DELETE", "POST"])
})

test("lost delete and restore receipts are reconciled by reads without replaying mutations", async t => {
  const service = fixture(t); service.loseDelete = true; service.loseRestore = true
  const view = await mount(t, "lifecycle-unknown")
  await flush(() => view().patchDraft(cid, { prompt: "需要保留" }))
  await flush(() => view().deleteCreation(cid))
  assert.equal(view().deletions[0].state, "delete-unknown"); assert.equal(view().activeCreationId, cid)
  await assert.rejects(view().deleteCreation(cid), /核对/)
  await flush(() => view().refresh())
  assert.equal(view().deletions[0].state, "deleted"); assert.notEqual(view().activeCreationId, cid)
  await flush(() => view().restoreCreation(cid))
  assert.equal(view().deletions[0].state, "restore-unknown")
  await flush(() => view().refresh())
  assert.equal(view().deletions.length, 0); assert.equal(view().getCreation(cid)?.draft.prompt, "需要保留")
  assert.equal(view().activeCreationId, cid); assert.equal(view().creations.length, 1)
  assert.deepEqual(service.writes, ["DELETE", "POST"])
})

test("conflicts and unresolved runs preserve the creation and prevent repeated or unsafe deletion", async t => {
  const service = fixture(t); service.rejectDelete = true
  const view = await mount(t, "lifecycle-conflict")
  await flush(async () => assert.rejects(view().deleteCreation(cid), /刷新/))
  assert.equal(view().creations[0].id, cid); assert.equal(view().deletions.length, 0)
  service.active[0] = { ...creation(), revision: 8, versions: [run, { ...run, id: "55555555-5555-4555-8555-555555555555", version: 2, status: "unknown", imageUrl: null }] }
  service.rejectDelete = false
  await flush(() => view().refresh())
  await flush(async () => assert.rejects(view().deleteCreation(cid), /先处理/))
  assert.equal(service.writes.length, 2)
})

test("a request unknown only on this device can be deleted without resubmitting it", async t => {
  const service = fixture(t)
  const account = "lifecycle-unreceived-request", orphanId = "55555555-5555-4555-8555-555555555555"
  const seed = mergePrivateWorkspace(emptyWorkspace(), service.active)
  seed.creations[0].versions.push({ ...seed.creations[0].versions[0], id: orphanId, version: 2, status: "error", runStatus: "unknown", imageUrl: null })
  await writeWorkspace(seed, 0, "seed", account)
  const view = await mount(t, account)
  await flush(() => view().refresh())
  assert.ok(view().getCreation(cid)?.versions.some(item => item.id === orphanId))
  await flush(() => view().deleteCreation(cid))
  assert.equal(view().getCreation(cid), undefined)
  await flush(() => view().applyRun({ ...run, id: orphanId, status: "generating", imageUrl: null }))
  assert.equal(view().getCreation(cid), undefined)
  assert.deepEqual(service.writes, ["DELETE"])
})

test("deleting an unsubmitted last editor creates a durable tombstone and a new blank editor", async t => {
  const service = fixture(t, [])
  const view = await mount(t, "lifecycle-empty")
  const id = view().activeCreationId!
  await flush(() => view().deleteCreation(id))
  assert.equal(view().creations.length, 1); assert.notEqual(view().activeCreationId, id); assert.equal(view().activeCreation?.localOnly, true)
  assert.equal(service.deleted[0].id, id); assert.deepEqual(service.writes, ["POST", "DELETE"])
  await flush(() => view().refresh())
  assert.equal(view().creations.some(item => item.id === id), false)
})

test("late list, rename and run responses cannot resurrect a confirmed deletion", async t => {
  const service = fixture(t)
  const originalFetch = globalThis.fetch
  let renameReply: ((response: Response) => void) | undefined
  let listReply: ((response: Response) => void) | undefined
  let delayList = false
  t.mock.method(globalThis, "fetch", (path: string, options?: RequestInit) => {
    if (options?.method === "PATCH") return new Promise<Response>(resolve => { renameReply = resolve })
    if (path === "/api/creations" && !options?.method && delayList) return new Promise<Response>(resolve => { listReply = resolve })
    return originalFetch(path, options)
  })
  const view = await mount(t, "lifecycle-late-responses")
  let rename!: Promise<void>
  await flush(() => { rename = view().renameCreation(cid, "延迟名称") })
  await eventually(() => assert.ok(renameReply))
  const renamed = { ...creation(), title: "延迟名称", revision: 8 }
  service.active = [renamed]
  await flush(() => view().refresh())
  delayList = true
  let refresh!: Promise<void>
  await flush(() => { refresh = view().refresh() })
  await eventually(() => assert.ok(listReply))
  await flush(() => view().deleteCreation(cid))
  await flush(async () => {
    renameReply!(Response.json({ creation: renamed }))
    listReply!(Response.json({ creations: [renamed], deletedCreations: [] }))
    await Promise.all([rename, refresh])
    view().applyRun({ ...run, creationRevision: 8 })
  })
  assert.equal(view().creations.some(item => item.id === cid), false)
  assert.equal(view().deletions[0].state, "deleted")
})

test("undo keeps a blank editor with input still being prepared, including lost receipts", async t => {
  const service = fixture(t)
  let preparingId: string | undefined
  const view = await mount(t, "lifecycle-undo-pending-input", id => preparingId === id)
  for (const loseReceipt of [false, true]) {
    service.loseRestore = loseReceipt
    await flush(() => view().deleteCreation(cid))
    preparingId = view().activeCreationId!
    await flush(() => view().restoreCreation(cid))
    if (loseReceipt) await flush(() => view().refresh())
    assert.equal(view().activeCreationId, cid)
    assert.ok(view().getCreation(preparingId), "an in-progress reference conversion is occupied input")
    await flush(() => view().patchDraft(preparingId!, { image1: new File(["converted reference"], "prepared.png", { type: "image/png" }) }))
    assert.equal(await view().getCreation(preparingId)?.draft.image1?.text(), "converted reference")
    await flush(() => view().patchDraft(preparingId!, { image1: null }))
    preparingId = undefined
  }
})

test("the creation menu requires confirmation and keeps the dialog open on failure", async t => {
  let writes = 0
  const container = win.document.createElement("div"); win.document.body.append(container)
  const root = createRoot(container as unknown as HTMLElement)
  t.after(async () => { await flush(() => root.unmount()); container.remove(); win.document.body.style.pointerEvents = "" })
  await flush(() => root.render(<CreationList creations={[{ ...creation(), unread: false, versions: [] }]} activeId={cid} onSelect={() => {}} onCreate={() => {}} onRename={() => {}} deletionBlocked={() => null} onDelete={async () => { writes++; throw new Error("请刷新后核对") }} />))
  const openDelete = async () => {
    await flush(() => win.document.querySelector('[aria-label="创作操作 主要创作"]')!.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
    await eventually(() => assert.ok(win.document.querySelector('[role="menuitem"]')))
    await flush(() => [...win.document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes("删除创作"))!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })))
    await eventually(() => assert.ok(win.document.querySelector('[role="alertdialog"]')))
  }
  await openDelete(); assert.equal(writes, 0)
  await flush(() => (Array.from(win.document.querySelectorAll('[role="alertdialog"] button')).find(item => item.textContent === "取消") as InstanceType<typeof win.HTMLButtonElement>).click())
  await eventually(() => assert.equal(win.document.querySelector('[role="alertdialog"]'), null)); assert.equal(writes, 0)
  assert.notEqual(win.document.body.style.pointerEvents, "none", "cancelling a menu-opened dialog must release page interactions")
  await eventually(() => assert.equal(win.document.activeElement?.getAttribute("aria-label"), "创作操作 主要创作"))
  await openDelete()
  await flush(() => (Array.from(win.document.querySelectorAll('[role="alertdialog"] button')).find(item => item.textContent === "删除创作") as InstanceType<typeof win.HTMLButtonElement>).click())
  assert.equal(writes, 1); assert.match(win.document.querySelector('[role="alertdialog"]')!.textContent!, /请刷新后核对/)
})
