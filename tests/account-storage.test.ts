import assert from "node:assert/strict"
import { test } from "node:test"
import { IDBFactory } from "fake-indexeddb"
import { Window } from "happy-dom"
import { createElement, act } from "react"
import { accountStorageKey, EMERGENCY_DRAFT_KEY, emptyWorkspace, newCreation, addCreation, writeWorkspace, readWorkspace, restoreWorkspace, emergencyDraftEntry, serializeEmergencyDrafts } from "../lib/creative-workspace"
import { useCreativeWorkspace } from "../components/image-combiner/hooks/use-creative-workspace"
import { useModelCatalog } from "../components/image-combiner/hooks/use-model-catalog"

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("actual IndexedDB and hook hydration keep account workspaces, emergency drafts and provider credentials separate", async (t) => {
  const browser = new Window({ url: "http://localhost:3000" })
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator,
    localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, indexedDB: new IDBFactory(), IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  }
  let remoteAccount = "account-a"
  const requests: string[] = []
  const reads: string[] = []
  const originalRead = localStorage.getItem.bind(localStorage)
  t.mock.method(localStorage, "getItem", (key: string) => { reads.push(key); return originalRead(key) })
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url))
    assert.equal(init?.body, undefined)
    if (String(url) === "/api/creations") return Response.json({ creations: remoteAccount === "account-a" ? [{ id: "creation-a", title: "A", revision: 1, createdAt: 100, updatedAt: 100, versions: [] }] : [] })
    return Response.json({ revision: 1, configured: true, apiMode: "images", mappings: [{ id: "shared", name: "共用模型", aspectRatios: ["square"], annotation: { available: false, expression: null, maxInputImages: 2, reason: "未核验" } }] })
  })
  const { createRoot } = await import("react-dom/client")
  const a = addCreation(emptyWorkspace(), newCreation({ prompt: "A saved draft" }, "creation-a"))
  await writeWorkspace(a, 0, "write-a", "account-a")
  assert.equal(restoreWorkspace(await readWorkspace("account-a")).creations[0].draft.prompt, "A saved draft")
  assert.equal(await readWorkspace("account-b"), undefined)

  // A valid anonymous IndexedDB workspace and old browser keys must stay out of B.
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("image-playground-creations", 1)
    open.onupgradeneeded = () => open.result.createObjectStore("workspace")
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction("workspace", "readwrite")
      tx.objectStore("workspace").put(a, "current")
      tx.oncomplete = () => { open.result.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  })
  const provider = { settings: { baseUrl: "https://relay.example/v1", apiKey: "synthetic-secret-for-account-a", apiMode: "images" }, models: [], mappings: [{ id: "mapping-a", name: "A only", modelId: "synthetic-model" }], modelsSynced: false }
  localStorage.setItem(accountStorageKey("image-playground-api-settings-v1", "account-a"), JSON.stringify(provider))
  localStorage.setItem("image-playground-api-settings-v1", JSON.stringify({ ...provider, settings: { ...provider.settings, apiKey: "anonymous-secret" } }))
  sessionStorage.setItem("draft_form_state", JSON.stringify({ prompt: "anonymous draft must not import" }))
  const saved = restoreWorkspace(await readWorkspace("account-a"))
  const entry = emergencyDraftEntry({ ...saved.creations[0], draft: { ...saved.creations[0].draft, prompt: "A emergency draft" }, draftRevision: 1 }, saved.creations[0])
  sessionStorage.setItem(accountStorageKey(EMERGENCY_DRAFT_KEY, "account-a"), serializeEmergencyDrafts(saved.revision, null, [entry], "creation-a"))

  let latest: { workspace: ReturnType<typeof useCreativeWorkspace>; provider: ReturnType<typeof useModelCatalog> } | undefined
  function snapshot() { return latest }
  function Probe({ id }: { id: string }) {
    const workspace = useCreativeWorkspace(id)
    const provider = useModelCatalog()
    latest = { workspace, provider }
    return createElement("div", null, workspace.activeCreation?.draft.prompt)
  }
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  async function renderAccount(id: string) {
    latest = undefined
    remoteAccount = id
    await act(async () => root.render(createElement(Probe, { id, key: id })))
    for (let i = 0; i < 100 && (!snapshot()?.workspace.ready || !snapshot()?.provider.ready); i++) {
      await act(async () => { await wait(5) })
    }
    const current = snapshot()
    assert.ok(current)
    assert.equal(current.workspace.ready, true)
    return current
  }
  try {
    const first = await renderAccount("account-a")
    assert.equal(first.workspace.activeCreation?.draft.prompt, "A emergency draft")
    assert.deepEqual(first.provider.mappings.map(mapping => mapping.id), ["shared"])
    const second = await renderAccount("account-b")
    assert.equal(second.workspace.creations.length, 1)
    assert.equal(second.workspace.activeCreation?.draft.prompt, "")
    assert.deepEqual(second.provider.mappings.map(mapping => mapping.id), ["shared"])
    const bId = second.workspace.activeCreation!.id
    await act(async () => { second.workspace.patchDraft(bId, { prompt: "B private draft" }) })
    assert.match(sessionStorage.getItem(accountStorageKey(EMERGENCY_DRAFT_KEY, "account-b"))!, /B private draft/)
    await act(async () => { await wait(220) })
    const restoredA = await renderAccount("account-a")
    assert.equal(restoredA.workspace.activeCreation?.draft.prompt, "A emergency draft")
    assert.deepEqual(restoredA.provider.mappings.map(mapping => mapping.id), ["shared"])
    const restoredB = await renderAccount("account-b")
    assert.equal(restoredB.workspace.activeCreation?.draft.prompt, "B private draft")
    assert.ok(requests.length >= 4)
    assert.ok(requests.every(path => path === "/api/models" || path === "/api/creations"))
    assert.ok(reads.every(key => !key.startsWith("image-playground-api-settings")))
    assert.equal(originalRead("image-playground-api-settings-v1")?.includes("anonymous-secret"), true)
  } finally {
    await act(async () => root.unmount())
    await wait(25)
    await browser.happyDOM.close()
  }
})

test("account namespace rejects missing and ambiguous identity", () => {
  for (const id of ["", "../another", "account:a", "a".repeat(129)]) assert.throws(() => accountStorageKey("draft", id), /账号标识无效/)
})
