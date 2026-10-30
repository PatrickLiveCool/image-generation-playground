import assert from "node:assert/strict"
import { test } from "node:test"
import { IDBFactory } from "fake-indexeddb"
import { annotationDisplayBounds, createEmptyAnnotationSnapshot, orientedImageSize, type AnnotationDraft } from "../lib/image-annotations"
import { containImageRect, drawnAnnotation, nudgeAnnotation, replaceAnnotationMarks } from "../lib/annotation-draft"
import { addCreation, applyPrivateRun, emergencyDraftEntry, emptyWorkspace, failCreationGeneration, newCreation, patchCreationDraft, readWorkspace, recoverEmergencyDrafts, restoreWorkspace, selectCreationVersion, serializeEmergencyDrafts, startCreationGeneration, workspaceSnapshot, writeWorkspace, accountStorageKey } from "../lib/creative-workspace"
import { buildCreationRequest } from "../lib/creation-request"
import type { PrivateRun } from "../lib/private-workspace-types"

const cid = "11111111-1111-4111-8111-111111111111", v1 = "22222222-2222-4222-8222-222222222222", v2 = "33333333-3333-4333-8333-333333333333", asset = "44444444-4444-4444-8444-444444444444"
const image = { assetId: asset, width: 400, height: 200, orientation: 1, pages: 1 as const }
const catalog = { revision: 1, configured: true, apiMode: "images" as const, mappings: [{ id: "m", name: "编辑", aspectRatios: ["square"], annotation: { available: true, expression: "overlay-v1" as const, maxInputImages: 2 as const, reason: null } }] }
function draft(baseVersionId = v1): AnnotationDraft {
  return { snapshot: { ...createEmptyAnnotationSnapshot(baseVersionId, image), marks: [{ id: "55555555-5555-4555-8555-555555555555", number: 3, instruction: "把区域改为红色", geometry: { type: "rectangle", x: 40, y: 30, width: 80, height: 60 } }] }, revision: 2, nextNumber: 4 }
}
function workspace() {
  const creation = newCreation({ selectedMappingId: "m", annotationDrafts: { [v1]: draft(), [v2]: draft(v2) } }, cid)
  creation.selectedVersionId = v1
  creation.versions = [v1, v2].map((id, index) => ({ id, status: "complete" as const, imageUrl: `/api/images/${asset}`, prompt: "", timestamp: index + 1, progress: 100, version: index + 1 }))
  return addCreation(emptyWorkspace(), creation)
}
function run(id: string): PrivateRun {
  return { id, creationId: cid, creationRevision: 3, version: 3, parentVersionId: v1, status: "complete", imageUrl: `/api/images/${asset}`, prompt: "", mappingId: "m", modelLabel: "编辑", aspectRatio: "square", quality: "auto", mode: "image-editing", createdAt: 3, updatedAt: 4, annotationSnapshot: draft().snapshot }
}

test("object-contain uses the actual letterboxed image and all eight orientations retain the drawn region", () => {
  assert.deepEqual(containImageRect({ width: 300, height: 400 }, image), { left: 0, top: 125, width: 300, height: 150, scale: .75 })
  for (let orientation = 1; orientation <= 8; orientation++) {
    const oriented = { ...image, orientation }, size = orientedImageSize(oriented)
    for (const type of ["rectangle", "lasso", "brush"] as const) {
      const points = [{ x: size.width * .2, y: size.height * .2 }, { x: size.width * .5, y: size.height * .5 }, { x: size.width * .3, y: size.height * .6 }]
      const geometry = drawnAnnotation(type, type === "rectangle" ? points.slice(0, 2) : points, oriented, 10)
      const mark = { ...draft().snapshot.marks[0], geometry }
      const bounds = annotationDisplayBounds(mark, oriented)
      assert.ok(Math.abs(bounds.x - (size.width * .2 - (type === "brush" ? 5 : 0))) < .01)
      const shifted = nudgeAnnotation(mark, oriented, 3, 2)
      assert.equal(annotationDisplayBounds(shifted, oriented).x, bounds.x + 3)
      assert.equal(annotationDisplayBounds(shifted, oriented).y, bounds.y + 2)
    }
  }
})

test("empty overall prompt freezes only the current base and rejects occupied inputs or unknown model capability", () => {
  const creation = workspace().creations[0]
  const built = buildCreationRequest({ creation, catalog })
  assert.equal(built.formData.get("prompt"), "")
  assert.equal(built.generation.submittedAnnotationRevision, 2)
  assert.deepEqual(JSON.parse(String(built.formData.get("annotationSnapshot"))), draft().snapshot)
  creation.draft.annotationDrafts![v1].snapshot.marks[0].instruction = "后续编辑"
  assert.equal(built.generation.annotationSnapshot!.marks[0].instruction, "把区域改为红色")
  for (const patch of [{ image1Url: "https://example.test/ref.png", useUrls: true }, { documentFile: new File(["text"], "brief.txt"), documentImageInspection: "unknown" as const }]) assert.throws(() => buildCreationRequest({ creation: { ...creation, draft: { ...creation.draft, ...patch } }, catalog }), /参考图|纯 TXT/)
  assert.throws(() => buildCreationRequest({ creation, catalog: { ...catalog, mappings: [{ ...catalog.mappings[0], annotation: { ...catalog.mappings[0].annotation, available: false, expression: null, reason: "未确认能力" } }] } }), /未确认能力/)
  const withText = { ...creation, draft: { ...creation.draft, documentFile: new File(["text"], "brief.txt"), documentImageInspection: "none" as const } }
  assert.ok(buildCreationRequest({ creation: withText, catalog }).formData.has("document"))
})

test("failure retains annotations and success clears only the frozen unchanged base bucket", () => {
  const state = workspace(), prepared = buildCreationRequest({ creation: state.creations[0], catalog }).generation
  const pending = startCreationGeneration(state, cid, prepared)
  assert.equal(failCreationGeneration(pending, cid, prepared.id, "失败").creations[0].draft.annotationDrafts, pending.creations[0].draft.annotationDrafts)
  const newerPrompt = patchCreationDraft(pending, cid, { prompt: "下一步整体修改" })
  const completed = applyPrivateRun(newerPrompt, run(prepared.id)).creations[0]
  assert.equal(completed.draft.prompt, "下一步整体修改")
  assert.equal(completed.draftRevision, newerPrompt.creations[0].draftRevision + 1, "annotation-only cleanup must refresh emergency storage too")
  assert.equal(completed.draft.annotationDrafts?.[v1], undefined)
  assert.deepEqual(completed.draft.annotationDrafts?.[v2], draft(v2))
  const editedDraft = replaceAnnotationMarks(draft(), [{ ...draft().snapshot.marks[0], instruction: "生成期间继续写" }])
  const edited = patchCreationDraft(pending, cid, { annotationDrafts: { ...pending.creations[0].draft.annotationDrafts, [v1]: editedDraft } })
  assert.deepEqual(applyPrivateRun(edited, run(prepared.id)).creations[0].draft.annotationDrafts?.[v1], editedDraft)
  assert.equal(startCreationGeneration(selectCreationVersion(state, cid, v2), cid, prepared).creations[0].versions.length, 2)
})

test("schema2 canonical and emergency copies restore per-base buckets and reject damaged annotation input", () => {
  const state = workspace()
  assert.deepEqual(restoreWorkspace(workspaceSnapshot(state)).creations[0].draft.annotationDrafts, state.creations[0].draft.annotationDrafts)
  const changed = patchCreationDraft(state, cid, { prompt: "最后一次编辑" })
  const raw = serializeEmergencyDrafts(0, null, [emergencyDraftEntry(changed.creations[0], state.creations[0])])
  assert.deepEqual(recoverEmergencyDrafts(state, raw).workspace.creations[0].draft.annotationDrafts, state.creations[0].draft.annotationDrafts)
  const corrupt = workspaceSnapshot(state); corrupt.creations[0].draft.annotationDrafts![v1].snapshot.image.width = -1
  assert.throws(() => restoreWorkspace(corrupt), /批注/)
  assert.throws(() => recoverEmergencyDrafts(state, raw.replace('"revision":2', '"revision":-2')), /批注/)
  assert.throws(() => recoverEmergencyDrafts(state, '{"schema":3}'), /停止覆盖/)
})

test("schema1 upgrade keeps the exact original record and future schema cannot be overwritten", async () => {
  const previous = globalThis.indexedDB
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() })
  try {
    const account = "annotation-schema-test"
    const legacy = { ...workspaceSnapshot(workspace()), schema: 1 }
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open(accountStorageKey("image-playground-creations", account), 1); open.onupgradeneeded = () => open.result.createObjectStore("workspace"); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("workspace", "readwrite"); tx.objectStore("workspace").put(legacy, "current"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) })
    assert.equal(restoreWorkspace(await readWorkspace(account)).schema, 2)
    await writeWorkspace(restoreWorkspace(legacy), 0, "upgrade", account)
    const backup = await new Promise<unknown>((resolve, reject) => { const request = db.transaction("workspace", "readonly").objectStore("workspace").get("schema1-backup-0"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    assert.deepEqual(backup, legacy)
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("workspace", "readwrite"); tx.objectStore("workspace").put({ ...legacy, schema: 3, revision: 1 }, "current"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) })
    await assert.rejects(writeWorkspace(workspace(), 1, "forbidden", account), /避免覆盖/)
    db.close()
  } finally { Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: previous }) }
})
