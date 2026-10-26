import { strict as assert } from "node:assert"
import { test } from "node:test"
// @ts-expect-error Node's built-in TypeScript runner requires file extension.
import { activateCreation, addCreation, completeCreationGeneration, emergencyDraftEntry, emptyWorkspace, failCreationGeneration, mergeLegacyHistory, migrateLegacyWorkspace, newCreation, patchCreationDraft, recoverEmergencyDrafts, renameCreation, restoreWorkspace, selectCreationVersion, serializeEmergencyDrafts, startCreationGeneration, UNKNOWN_REQUEST_MESSAGE, updateCreationGeneration, workspaceSnapshot } from "../lib/creative-workspace.ts"
import type { Generation } from "../components/image-combiner/types"
import type { CreativeWorkspace } from "../lib/creation-types"

const generation = (id: string, prompt = "让标题变大", aspectRatio = "square"): Generation => ({ id, prompt, timestamp: 100, status: "loading", progress: 0, imageUrl: null, aspectRatio })
const get = (state: CreativeWorkspace, id = "a") => state.creations.find(creation => creation.id === id)!
function withVersion() {
  let state = addCreation(emptyWorkspace(), newCreation({ prompt: "生成山景海报" }, "a", 1))
  state = startCreationGeneration(state, "a", generation("a1", "生成山景海报"))
  return completeCreationGeneration(state, "a", "a1", { imageUrl: "/api/assets/a1" }, 2)
}

test("a pending revision retains its displayed base and rejects duplicate submissions and base changes", () => {
  let state = withVersion()
  state = patchCreationDraft(state, "a", { prompt: "让标题变大" })
  state = startCreationGeneration(state, "a", generation("a2"))
  assert.equal(get(state).selectedVersionId, "a1")
  assert.equal(get(state).versions[0].version, 2)
  assert.equal(get(state).versions[0].parentVersionId, "a1")
  assert.equal(get(state).draft.prompt, "让标题变大")
  assert.equal(startCreationGeneration(state, "a", generation("duplicate")), state)
  assert.equal(selectCreationVersion(state, "a", "a1"), state)

  state = updateCreationGeneration(state, "a", "a2", { id: "forged", creationId: "b", parentVersionId: "wrong", version: 9, status: "complete", imageUrl: "forged", prompt: "wrong", progress: 50, phase: "generating" })
  assert.equal(get(state).versions[0].id, "a2")
  assert.equal(get(state).versions[0].creationId, "a")
  assert.equal(get(state).versions[0].parentVersionId, "a1")
  assert.equal(get(state).versions[0].status, "loading")
  assert.equal(get(state).versions[0].imageUrl, null)
  assert.equal(get(state).versions[0].prompt, "让标题变大")
  assert.equal(get(state).versions[0].progress, 50)
})

test("inactive completion updates its originating creation without changing the current creation or its draft", () => {
  let state = withVersion()
  state = patchCreationDraft(state, "a", { prompt: "让标题变大" })
  state = startCreationGeneration(state, "a", generation("a2"))
  state = addCreation(state, newCreation({ prompt: "另一张产品图" }, "b", 3))
  const previousB = get(state, "b")
  state = completeCreationGeneration(state, "a", "a2", { imageUrl: "/api/assets/a2" }, 4)
  assert.equal(state.activeCreationId, "b")
  assert.equal(get(state, "b"), previousB)
  assert.equal(get(state).selectedVersionId, "a2")
  assert.equal(get(state).unread, true)
  assert.equal(get(state).draft.prompt, "")
  state = activateCreation(state, "a")
  assert.equal(state.activeCreationId, "a")
  assert.equal(get(state).unread, false)
})

test("failure and cancellation preserve completed base and the submitted draft for retry", () => {
  for (const message of ["上游请求失败", "已取消生成"]) {
    let state = withVersion()
    const reference = new File(["image"], "reference.png", { type: "image/png" })
    state = patchCreationDraft(state, "a", { prompt: "按参考修改", image1: reference })
    const draft = get(state).draft
    state = startCreationGeneration(state, "a", generation("a2"))
    state = failCreationGeneration(state, "a", "a2", message)
    assert.equal(get(state).selectedVersionId, "a1")
    assert.equal(get(state).draft, draft)
    assert.equal(get(state).versions[0].error, message)
    assert.equal(get(state).versions[0].status, "error")
    assert.equal(completeCreationGeneration(state, "a", "a2", { imageUrl: "/api/assets/late" }), state)
    state = startCreationGeneration(state, "a", generation("a3"))
    assert.equal(get(state).versions[0].version, 2)
    assert.equal(get(state).versions[0].parentVersionId, "a1")
  }
})

test("success clears submitted material but preserves newer draft edits", () => {
  const reference = new File(["image"], "reference.png", { type: "image/png" })
  for (const editWhilePending of [false, true]) {
    let state = withVersion()
    state = patchCreationDraft(state, "a", { prompt: "修改颜色", image1: reference, image1Url: "https://example.test/ref.png", selectedMappingId: "balanced", quality: "high" })
    state = startCreationGeneration(state, "a", generation("a2", "修改颜色"))
    if (editWhilePending) state = patchCreationDraft(state, "a", { prompt: "下一步调整构图" })
    state = completeCreationGeneration(state, "a", "a2", { imageUrl: "/api/assets/a2" })
    assert.equal(get(state).draft.prompt, editWhilePending ? "下一步调整构图" : "")
    assert.equal(get(state).draft.image1, editWhilePending ? reference : null)
    assert.equal(get(state).draft.image1Url, editWhilePending ? "https://example.test/ref.png" : "")
    assert.equal(get(state).draft.selectedMappingId, "balanced")
    assert.equal(get(state).draft.quality, "high")
  }
})

test("continuing from an older version preserves all results, uses its aspect ratio, and records the chosen parent", () => {
  let state = withVersion()
  state = patchCreationDraft(state, "a", { aspectRatio: "portrait", prompt: "换成竖版" })
  state = startCreationGeneration(state, "a", generation("a2", "换成竖版", "portrait"))
  state = completeCreationGeneration(state, "a", "a2", { imageUrl: "/api/assets/a2" })
  state = selectCreationVersion(state, "a", "a1")
  assert.equal(get(state).draft.aspectRatio, "square")
  state = startCreationGeneration(state, "a", generation("a3"))
  assert.equal(get(state).versions[0].version, 3)
  assert.equal(get(state).versions[0].parentVersionId, "a1")
  assert.equal(get(state).selectedVersionId, "a1")
  assert.equal(get(state).versions.filter(version => version.status === "complete").length, 2)
})

test("creation selection, renaming, and edits retain independent drafts and uploaded references", () => {
  const referenceA = new File(["A"], "a.png", { type: "image/png" })
  const referenceB = new File(["B"], "b.png", { type: "image/png" })
  let state = addCreation(emptyWorkspace(), newCreation({ prompt: "A", image1: referenceA }, "a", 1))
  state = addCreation(state, newCreation({ prompt: "B", image1: referenceB }, "b", 2))
  state = activateCreation(state, "a")
  state = patchCreationDraft(state, "a", { prompt: "A 修改" })
  state = renameCreation(state, "a", "  山景海报  ")
  assert.equal(get(state).title, "山景海报")
  assert.equal(get(state).draft.prompt, "A 修改")
  assert.equal(get(state).draft.image1, referenceA)
  assert.equal(get(state, "b").draft.prompt, "B")
  assert.equal(get(state, "b").draft.image1, referenceB)
  assert.equal(activateCreation(state, "missing"), state)
  assert.throws(() => renameCreation(state, "a", "\n"))
  assert.throws(() => renameCreation(state, "a", "分行\n标题"))
})

test("migration retains legacy images as independent V1 creations without inventing ancestry", async () => {
  const history = [
    { ...generation("legacy-1", "第一张"), status: "complete", imageUrl: "https://old.test/1.png", timestamp: 1, aspectRatio: "portrait" },
    { ...generation("legacy-2", "第二张"), status: "complete", imageUrl: "https://old.test/2.png", timestamp: 2 },
  ]
  const oldDraft = { prompt: "尚未提交", selectedMappingId: "ultimate", image1Preview: "data:image/png;base64,aGVsbG8=", useUrls: false, quality: "high" }
  let nextId = 0
  const state = migrateLegacyWorkspace(JSON.stringify(history), JSON.stringify(oldDraft), 4, () => `migrated-${++nextId}`)
  assert.equal(state.creations.length, 2)
  assert.equal(state.activeCreationId, "migrated-1")
  assert.deepEqual(state.creations.map(creation => creation.versions[0].id), ["legacy-2", "legacy-1"])
  for (const creation of state.creations) {
    assert.equal(creation.versions.length, 1)
    assert.equal(creation.versions[0].version, 1)
    assert.equal(creation.versions[0].parentVersionId, null)
    assert.equal(creation.versions[0].creationId, creation.id)
    assert.equal(creation.selectedVersionId, creation.versions[0].id)
  }
  assert.equal(state.creations[0].draft.prompt, "尚未提交")
  assert.equal(state.creations[0].draft.selectedMappingId, "ultimate")
  assert.equal(await state.creations[0].draft.image1?.text(), "hello")
  assert.equal(state.creations[1].draft.aspectRatio, "portrait")
  assert.equal(state.creations[1].draft.prompt, "")
})

test("reloading an interrupted request marks it unknown without retrying or losing the prior version and draft", () => {
  let state = withVersion()
  state = patchCreationDraft(state, "a", { prompt: "重试前应保留" })
  state = startCreationGeneration(state, "a", generation("a2"))
  const restored = restoreWorkspace(workspaceSnapshot(state))
  assert.equal(get(restored).versions[0].status, "error")
  assert.equal(get(restored).versions[0].error, UNKNOWN_REQUEST_MESSAGE)
  assert.equal(get(restored).selectedVersionId, "a1")
  assert.equal(get(restored).draft.prompt, "重试前应保留")
  assert.equal(get(restored).pendingDraftRevision, null)
  assert.equal(get(restored).versions.some(version => version.status === "loading"), false)
})

test("late results from old tabs import once without changing current creation, selected version, or draft", () => {
  let state = withVersion()
  state = patchCreationDraft(state, "a", { prompt: "正在修改的草稿", selectedMappingId: "balanced" })
  state.revision = 4
  const existing = get(state)
  const legacy = JSON.stringify([
    { ...generation("a1", "duplicate from earlier migration"), status: "complete", imageUrl: "/api/assets/a1", timestamp: 1 },
    { ...generation("late-old-tab", "旧标签新生成"), status: "complete", imageUrl: "/api/assets/late", timestamp: 3 },
    { ...generation("late-old-tab", "重复结果"), status: "complete", imageUrl: "/api/assets/late", timestamp: 3 },
    { ...generation("still-pending"), status: "loading" },
  ])
  let generatedIds = 0
  const merged = mergeLegacyHistory(state, legacy, () => `imported-${++generatedIds}`)
  assert.equal(merged.creations.length, 2)
  assert.equal(merged.activeCreationId, "a")
  assert.equal(merged.revision, 4)
  assert.equal(get(merged), existing)
  assert.equal(get(merged).selectedVersionId, "a1")
  assert.equal(get(merged).draft.prompt, "正在修改的草稿")
  assert.equal(merged.creations[0].versions[0].id, "late-old-tab")
  assert.equal(merged.creations[0].versions[0].version, 1)
  assert.equal(merged.creations[0].versions[0].parentVersionId, null)
  assert.equal(merged.creations[0].draft.prompt, "")
  assert.equal(mergeLegacyHistory(merged, legacy, () => `imported-${++generatedIds}`), merged)
  assert.equal(generatedIds, 1)
})

test("workspace snapshots exclude API credentials, controllers, and accidental transient properties", () => {
  const state = withVersion()
  Object.assign(state, { apiKey: "top-secret", controller: new AbortController() })
  Object.assign(get(state), { token: "creation-secret" })
  Object.assign(get(state).draft, { baseUrl: "https://secret.test", apiKey: "draft-secret" })
  Object.assign(get(state).versions[0], { abortController: new AbortController(), apiKey: "request-secret", phase: "sending" })
  const snapshot = workspaceSnapshot(state)
  const serialized = JSON.stringify(snapshot)
  for (const value of ["top-secret", "creation-secret", "secret.test", "draft-secret", "request-secret", "abortController", "phase"]) assert.equal(serialized.includes(value), false)
  assert.doesNotThrow(() => structuredClone(snapshot))
})

test("unsupported or corrupt stored workspaces are rejected instead of silently replaced", () => {
  assert.throws(() => restoreWorkspace({ ...withVersion(), schema: 2 }), /版本不兼容|损坏/)
  assert.throws(() => restoreWorkspace({ ...withVersion(), revision: -1 }))
  const duplicate = withVersion()
  duplicate.creations.push(duplicate.creations[0])
  assert.throws(() => restoreWorkspace(duplicate), /格式无效/)
  const brokenDraft = withVersion()
  Object.assign(get(brokenDraft).draft, { image1: "not-a-file" })
  assert.throws(() => restoreWorkspace(brokenDraft), /参考图/)
  assert.throws(() => migrateLegacyWorkspace("not-json", null))
})

test("synchronous emergency drafts recover the final keystroke before a debounced IndexedDB save", () => {
  const saved = withVersion()
  saved.revision = 5
  const changed = patchCreationDraft(saved, "a", { prompt: "刷新后仍从 V1 编辑", quality: "high" })
  const backup = serializeEmergencyDrafts(5, null, [emergencyDraftEntry(get(changed), get(saved))])
  const recovery = recoverEmergencyDrafts(restoreWorkspace(workspaceSnapshot(saved)), backup)
  assert.equal(get(recovery.workspace).draft.prompt, "刷新后仍从 V1 编辑")
  assert.equal(get(recovery.workspace).draft.quality, "high")
  assert.equal(get(recovery.workspace).selectedVersionId, "a1")
  assert.equal(recovery.workspace.revision, 5)
})

test("a newer emergency edit survives an older in-flight save committing during reload", () => {
  const saved = withVersion()
  saved.revision = 5
  const inFlight = patchCreationDraft(saved, "a", { prompt: "较早的输入" })
  const latest = patchCreationDraft(inFlight, "a", { prompt: "最后输入" })
  const backup = serializeEmergencyDrafts(5, "own-save", [emergencyDraftEntry(get(latest), get(inFlight))])
  const committed = { ...inFlight, revision: 6, lastWriteId: "own-save" }
  const recovery = recoverEmergencyDrafts(committed, backup)
  assert.equal(get(recovery.workspace).draft.prompt, "最后输入")
  assert.equal(get(recovery.workspace).draftRevision, get(latest).draftRevision)
  const otherTab = { ...committed, lastWriteId: "another-tab-save" }
  assert.equal(recoverEmergencyDrafts(otherTab, backup).workspace, otherTab)
  const stillNewer = { ...committed, revision: 7 }
  assert.equal(recoverEmergencyDrafts(stillNewer, backup).workspace, stillNewer)
})

test("emergency storage excludes files, image data URLs, and arbitrary provider secrets", () => {
  const saved = withVersion()
  const file = new File(["private-image-bytes"], "private-reference.png", { type: "image/png" })
  const changed = patchCreationDraft(saved, "a", { image1: file, image1Url: "data:image/png;base64,cHJpdmF0ZQ==", prompt: "最新提示词" })
  Object.assign(get(changed).draft, { apiKey: "private-api-token", baseUrl: "https://private-relay.test" })
  const backup = serializeEmergencyDrafts(saved.revision, null, [emergencyDraftEntry(get(changed), get(saved))])
  for (const value of ["private-image-bytes", "private-reference.png", "data:image", "cHJpdmF0ZQ==", "private-api-token", "private-relay.test"]) assert.equal(backup.includes(value), false)
  const recovery = recoverEmergencyDrafts(saved, backup)
  assert.equal(get(recovery.workspace).draft.prompt, "最新提示词")
  assert.equal(get(recovery.workspace).draft.image1, null)
  assert.equal(recovery.referencesNeedReselect, true)
})

test("emergency recovery retains a reference already saved by the in-flight transaction", () => {
  const saved = withVersion()
  saved.revision = 5
  const file = new File(["image"], "reference.png", { type: "image/png" })
  const inFlight = patchCreationDraft(saved, "a", { image1: file })
  const firstEntry = emergencyDraftEntry(get(inFlight), get(saved))
  const latest = patchCreationDraft(inFlight, "a", { prompt: "最后输入" })
  const backup = serializeEmergencyDrafts(5, "own-save", [emergencyDraftEntry(get(latest), get(inFlight), firstEntry)])
  const recovery = recoverEmergencyDrafts({ ...inFlight, revision: 6, lastWriteId: "own-save" }, backup)
  assert.equal(get(recovery.workspace).draft.image1, file)
  assert.equal(get(recovery.workspace).draft.prompt, "最后输入")
  assert.equal(recovery.referencesNeedReselect, false)
})

test("emergency recovery can recreate an unsaved new creation without inventing image history", () => {
  const saved = withVersion()
  saved.revision = 5
  const created = newCreation({}, "new-creation", 123)
  const initialEntry = emergencyDraftEntry(created)
  const changed = patchCreationDraft(addCreation(saved, created), "new-creation", { prompt: "刚新建就刷新" })
  const backup = serializeEmergencyDrafts(5, null, [emergencyDraftEntry(get(changed, "new-creation"), created, initialEntry)], "new-creation")
  const recovery = recoverEmergencyDrafts(saved, backup)
  assert.equal(get(recovery.workspace, "new-creation").draft.prompt, "刚新建就刷新")
  assert.equal(get(recovery.workspace, "new-creation").versions.length, 0)
  assert.equal(get(recovery.workspace, "new-creation").selectedVersionId, null)
  assert.equal(recovery.workspace.activeCreationId, "new-creation")
  assert.equal(get(recovery.workspace), get(saved))
})

test("the emergency draft restores its chosen older base rather than applying new text to a different version", () => {
  let saved = withVersion()
  saved = startCreationGeneration(saved, "a", generation("a2"))
  saved = completeCreationGeneration(saved, "a", "a2", { imageUrl: "/api/assets/a2" })
  const selected = selectCreationVersion(saved, "a", "a1")
  const edited = patchCreationDraft(selected, "a", { prompt: "基于 V1 的修改" })
  const backup = serializeEmergencyDrafts(saved.revision, null, [emergencyDraftEntry(get(edited), get(selected))])
  const recovery = recoverEmergencyDrafts(saved, backup)
  assert.equal(get(recovery.workspace).selectedVersionId, "a1")
  assert.equal(get(recovery.workspace).draft.prompt, "基于 V1 的修改")
})

test("emergency completion cleanup never clears the draft if its new result has not reached IndexedDB", () => {
  let saved = withVersion()
  saved = patchCreationDraft(saved, "a", { prompt: "生成中的修改要求" })
  saved = startCreationGeneration(saved, "a", generation("a2"))
  const completed = completeCreationGeneration(saved, "a", "a2", { imageUrl: "/api/assets/a2" })
  const backup = serializeEmergencyDrafts(saved.revision, null, [emergencyDraftEntry(get(completed), get(saved))])
  const recovery = recoverEmergencyDrafts(saved, backup)
  assert.equal(recovery.workspace, saved)
  assert.equal(get(recovery.workspace).draft.prompt, "生成中的修改要求")
  assert.equal(get(recovery.workspace).selectedVersionId, "a1")
})
