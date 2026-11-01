import type { Generation } from "@/components/image-combiner/types"
import type { PrivateCreation, PrivateRun } from "./private-workspace-types"
import type { Creation, CreationDraft, CreativeWorkspace } from "./creation-types"

export const DEFAULT_CREATION_TITLE = "未命名创作"
export const UNKNOWN_REQUEST_MESSAGE = "页面刷新后请求状态未知，请查看状态，勿重复提交"
export const EMERGENCY_DRAFT_KEY = "image-playground-emergency-drafts-v1"
const DATABASE = "image-playground-creations"
const STORE = "workspace"
const KEY = "current"
const DRAFT_KEYS = ["prompt", "documentName", "documentText", "documentFile", "selectedMappingId", "aspectRatio", "quality", "useUrls", "image1", "image2", "image1Url", "image2Url"] as const
const QUALITIES = new Set(["auto", "low", "medium", "high"])

export function emptyDraft(initial: Partial<CreationDraft> = {}): CreationDraft {
  return { prompt: "", documentName: "", documentText: "", documentFile: null, selectedMappingId: "", aspectRatio: "square", quality: "auto", useUrls: false, image1: null, image2: null, image1Url: "", image2Url: "", ...initial }
}

export function emptyWorkspace(): CreativeWorkspace {
  return { schema: 1, revision: 0, activeCreationId: null, creations: [] }
}

export function newCreation(initial: Partial<CreationDraft> = {}, id: string = crypto.randomUUID(), now = Date.now()): Creation {
  return { id, title: DEFAULT_CREATION_TITLE, createdAt: now, updatedAt: now, selectedVersionId: null, draft: emptyDraft(initial), versions: [], unread: false, draftRevision: 0, pendingDraftRevision: null }
}

export function addCreation(workspace: CreativeWorkspace, creation: Creation): CreativeWorkspace {
  if (workspace.creations.some(item => item.id === creation.id)) return workspace
  return { ...workspace, activeCreationId: creation.id, creations: [creation, ...workspace.creations] }
}

function changeCreation(workspace: CreativeWorkspace, id: string, change: (creation: Creation) => Creation): CreativeWorkspace {
  const index = workspace.creations.findIndex(creation => creation.id === id)
  if (index < 0) return workspace
  const current = workspace.creations[index]
  const next = change(current)
  if (next === current) return workspace
  const creations = [...workspace.creations]
  creations[index] = next
  return { ...workspace, creations }
}

export function activateCreation(workspace: CreativeWorkspace, id: string): CreativeWorkspace {
  if (!workspace.creations.some(creation => creation.id === id)) return workspace
  const updated = changeCreation(workspace, id, creation => creation.unread ? { ...creation, unread: false } : creation)
  return updated.activeCreationId === id ? updated : { ...updated, activeCreationId: id }
}

export function renameCreation(workspace: CreativeWorkspace, id: string, title: string, now = Date.now()): CreativeWorkspace {
  const clean = title.trim()
  if (!clean || clean.length > 60 || /[\r\n]/.test(clean)) throw new Error("创作名称需要为 1–60 个字，不能包含换行。")
  return changeCreation(workspace, id, creation => creation.title === clean ? creation : { ...creation, title: clean, updatedAt: now })
}

export function patchCreationDraft(workspace: CreativeWorkspace, id: string, patch: Partial<CreationDraft>, now = Date.now()): CreativeWorkspace {
  return changeCreation(workspace, id, creation => {
    const draft = { ...creation.draft }
    let changed = false
    for (const key of DRAFT_KEYS) {
      if (key in patch && patch[key] !== draft[key]) {
        Object.assign(draft, { [key]: patch[key] })
        changed = true
      }
    }
    return changed ? { ...creation, draft, updatedAt: now, draftRevision: creation.draftRevision + 1 } : creation
  })
}

export function selectCreationVersion(workspace: CreativeWorkspace, creationId: string, versionId: string): CreativeWorkspace {
  return changeCreation(workspace, creationId, creation => {
    if (creation.versions.some(version => version.status === "loading")) return creation
    const selected = creation.versions.find(version => version.id === versionId && version.status === "complete" && version.imageUrl)
    if (!selected || creation.selectedVersionId === selected.id) return creation
    const aspectRatio = selected.aspectRatio || creation.draft.aspectRatio
    const changedAspectRatio = aspectRatio !== creation.draft.aspectRatio
    return { ...creation, selectedVersionId: selected.id, draft: changedAspectRatio ? { ...creation.draft, aspectRatio } : creation.draft, draftRevision: creation.draftRevision + 1 }
  })
}

export function startCreationGeneration(workspace: CreativeWorkspace, creationId: string, generation: Generation): CreativeWorkspace {
  return changeCreation(workspace, creationId, creation => {
    if (creation.versions.some(version => version.status === "loading" || version.id === generation.id)) return creation
    const parent = creation.versions.find(version => version.id === creation.selectedVersionId && version.status === "complete" && version.imageUrl)
    const version = Math.max(0, ...creation.versions.filter(item => item.status === "complete").map(item => item.version ?? 0)) + 1
    const next: Generation = { ...generation, creationId, version, parentVersionId: parent?.id ?? null, status: "loading", progress: 0, imageUrl: null, error: undefined, abortController: undefined }
    const title = creation.remoteRevision === undefined && creation.title === DEFAULT_CREATION_TITLE ? generation.prompt.replace(/\s+/g, " ").trim().slice(0, 24) || DEFAULT_CREATION_TITLE : creation.title
    return { ...creation, title, updatedAt: generation.timestamp, versions: [next, ...creation.versions], pendingDraftRevision: creation.draftRevision }
  })
}

export function updateCreationGeneration(workspace: CreativeWorkspace, creationId: string, id: string, patch: Partial<Generation>): CreativeWorkspace {
  return changeCreation(workspace, creationId, creation => {
    const index = creation.versions.findIndex(version => version.id === id && version.status === "loading")
    if (index < 0) return creation
    const versions = [...creation.versions]
    const current = versions[index]
    versions[index] = { ...current, ...(typeof patch.progress === "number" ? { progress: Math.max(0, Math.min(99, patch.progress)) } : {}), ...(patch.phase ? { phase: patch.phase } : {}) }
    return { ...creation, versions }
  })
}

export function completeCreationGeneration(workspace: CreativeWorkspace, creationId: string, id: string, result: { imageUrl: string }, now = Date.now()): CreativeWorkspace {
  if (!result.imageUrl) return workspace
  return changeCreation(workspace, creationId, creation => {
    if (!creation.versions.some(version => version.id === id && version.status === "loading")) return creation
    const sameDraft = creation.pendingDraftRevision === creation.draftRevision
    return {
      ...creation, updatedAt: now, selectedVersionId: id, unread: workspace.activeCreationId !== creationId, pendingDraftRevision: null,
      versions: creation.versions.map(version => version.id === id ? { ...version, status: "complete" as const, progress: 100, phase: undefined, imageUrl: result.imageUrl, error: undefined, abortController: undefined } : version),
      draft: sameDraft ? { ...creation.draft, prompt: "", documentName: "", documentText: "", documentFile: null, image1: null, image2: null, image1Url: "", image2Url: "" } : creation.draft,
      draftRevision: sameDraft ? creation.draftRevision + 1 : creation.draftRevision,
    }
  })
}

export function failCreationGeneration(workspace: CreativeWorkspace, creationId: string, id: string, message: string, now = Date.now()): CreativeWorkspace {
  return changeCreation(workspace, creationId, creation => {
    if (!creation.versions.some(version => version.id === id && version.status === "loading")) return creation
    return { ...creation, updatedAt: now, pendingDraftRevision: null, unread: workspace.activeCreationId !== creationId, versions: creation.versions.map(version => version.id === id ? { ...version, status: "error" as const, progress: 0, phase: undefined, error: message, abortController: undefined } : version) }
  })
}

const PRIVATE_FAILURE_MESSAGES: Record<string, string> = {
  BASE_VERSION_UNAVAILABLE: "基准版本暂不可用，请刷新创作后重新选择已保存的版本。",
  REFERENCE_INVALID: "参考图片无法使用，请重新选择有效图片或检查链接。",
  ACCOUNT_UNAVAILABLE: "当前账号或会话不可用，请重新检查登录状态。",
  MODEL_OUTPUT_INVALID: "模型没有返回有效图片，请检查模型配置并确认本次任务状态。",
  PROVIDER_AUTH_REJECTED: "模型服务认证失败，请联系管理员检查服务凭据。",
  PROVIDER_REQUEST_REJECTED: "模型服务拒绝了本次输入，请检查提示词、参考图和参数。",
  PROVIDER_RATE_LIMITED: "模型服务当前限流，请稍后查看任务状态再决定是否重新提交。",
  PROVIDER_UPSTREAM_FAILED: "模型服务暂时异常，请先查看本次任务状态，避免重复提交。",
  INPUT_READ_FAILED: "输入内容读取失败，请检查参考图和文档后重新选择。",
  INPUT_SAVE_FAILED: "输入内容未能保存，请稍后查看任务状态再决定是否重新提交。",
}

export function privateRunGeneration(run: PrivateRun): Generation {
  const loading = ["preparing", "generating", "saving"].includes(run.status)
  return {
    id: run.id, creationId: run.creationId, version: run.version, parentVersionId: run.parentVersionId,
    runStatus: run.status, status: run.status === "complete" ? "complete" : loading ? "loading" : "error",
    progress: run.status === "complete" ? 100 : 0, imageUrl: run.imageUrl, prompt: run.prompt,
    model: run.mappingId, modelLabel: run.modelLabel, aspectRatio: run.aspectRatio,
    quality: ["auto", "low", "medium", "high"].includes(run.quality) ? run.quality as CreationDraft["quality"] : "auto",
    mode: run.mode, timestamp: run.createdAt, document: run.document,
    error: run.status === "save_pending" ? "图片保存尚未确认，可仅补记保存；不会再次调用模型。"
      : run.status === "unknown" ? "任务结果未知，请查看状态；不要重复提交。"
      : run.status === "failed" ? PRIVATE_FAILURE_MESSAGES[run.failureCode ?? ""] ?? "本次任务未完成，输入已保留。" : undefined,
  }
}

/** Reconcile a server run with this device's submitted draft; never clear newer input. */
export function applyPrivateRun(workspace: CreativeWorkspace, run: PrivateRun): CreativeWorkspace {
  return changeCreation(workspace, run.creationId, creation => {
    const previous = creation.versions.find(version => version.id === run.id)
    const remoteRevision = Math.max(creation.remoteRevision ?? 0, run.creationRevision)
    if (previous?.runStatus === "complete" && run.status !== "complete") return remoteRevision === creation.remoteRevision ? creation : { ...creation, remoteRevision }
    const generation = { ...privateRunGeneration(run), submittedDraftRevision: previous?.submittedDraftRevision }
    const completedNow = run.status === "complete" && previous?.status !== "complete"
    const submittedHere = previous?.submittedDraftRevision !== undefined
    const sameBase = submittedHere && (previous.parentVersionId ?? null) === creation.selectedVersionId
    const clear = completedNow && sameBase && previous.submittedDraftRevision === creation.draftRevision
    return {
      ...creation, remoteRevision, updatedAt: Math.max(creation.updatedAt, run.updatedAt),
      versions: [generation, ...creation.versions.filter(version => version.id !== run.id)].sort((a, b) => b.timestamp - a.timestamp),
      selectedVersionId: completedNow && sameBase ? run.id : creation.selectedVersionId,
      unread: completedNow && submittedHere && workspace.activeCreationId !== creation.id ? true : creation.unread,
      pendingDraftRevision: ["complete", "failed"].includes(run.status) ? null : creation.pendingDraftRevision,
      draft: clear ? { ...creation.draft, prompt: "", documentName: "", documentText: "", documentFile: null, image1: null, image2: null, image1Url: "", image2Url: "" } : creation.draft,
      draftRevision: creation.draftRevision + (clear ? 1 : 0),
    }
  })
}

export function markPrivateRunUnknown(workspace: CreativeWorkspace, creationId: string, id: string, message: string): CreativeWorkspace {
  return changeCreation(workspace, creationId, creation => ({
    ...creation, versions: creation.versions.map(run => run.id === id && run.status !== "complete"
      ? { ...run, runStatus: run.runStatus === "save_pending" || run.runStatus === "failed" ? run.runStatus : "unknown", status: "error", progress: 0, phase: undefined, error: message } : run),
  }))
}

/** Only remote creations and remote successful versions are authoritative. Local data contributes drafts and unresolved request IDs. */
export function mergePrivateWorkspace(local: CreativeWorkspace, remote: PrivateCreation[], options: { preserveConfirmed?: boolean } = {}): CreativeWorkspace {
  const creations = remote.map(server => {
    const existing = local.creations.find(creation => creation.id === server.id)
    // Only live, confirmed state may reject a stale server snapshot; IndexedDB is never authoritative.
    if (options.preserveConfirmed && existing?.remoteRevision !== undefined && existing.remoteRevision > server.revision) return existing
    const versions = server.versions.map(run => {
      const confirmed = options.preserveConfirmed ? existing?.versions.find(item => item.id === run.id && item.runStatus === "complete") : undefined
      return confirmed && run.status !== "complete" ? confirmed : privateRunGeneration(run)
    }).sort((a, b) => b.timestamp - a.timestamp)
    const completingLocal = server.versions.some(run => run.status === "complete" && existing?.versions.some(before => before.id === run.id && before.status !== "complete" && before.submittedDraftRevision !== undefined))
    const selected = versions.find(run => run.id === existing?.selectedVersionId && run.status === "complete")
      ?? versions.find(run => run.status === "complete")
    const creation: Creation = {
      ...newCreation({}, server.id, server.createdAt), ...(existing ?? {}), title: server.title,
      remoteRevision: server.revision, localOnly: false, creationUnknown: false, createdAt: server.createdAt, updatedAt: server.updatedAt,
      selectedVersionId: completingLocal ? existing!.selectedVersionId : selected?.id ?? null,
      draft: existing?.draft ?? emptyDraft({ selectedMappingId: selected?.model ?? "", aspectRatio: selected?.aspectRatio ?? "square", quality: selected?.quality ?? "auto" }),
      versions: existing?.versions.filter(run => run.runStatus && run.status !== "complete" && !server.versions.some(item => item.id === run.id)) ?? [],
    }
    // Reconcile newly completed requests against the original local submission, while
    // other server versions are copied verbatim. Local successful image data never enters.
    creation.versions.push(...versions.map(run => {
      const before = existing?.versions.find(item => item.id === run.id)
      return before && before.status !== "complete" && run.status === "complete"
        ? before : { ...run, submittedDraftRevision: before?.submittedDraftRevision }
    }))
    let merged = { ...local, creations: [creation] }
    for (const run of server.versions) {
      const before = existing?.versions.find(item => item.id === run.id)
      if (before && before.status !== "complete" && run.status === "complete") merged = applyPrivateRun(merged, run)
    }
    return merged.creations[0]
  })
  // An unsubmitted editor is the sole allowed local-only creation. It never imports historical images.
  const blank = local.creations.find(creation => creation.localOnly && !creation.versions.length && !remote.some(item => item.id === creation.id))
  if (blank) creations.unshift({ ...blank, creationUnknown: false })
  return { ...local, creations, activeCreationId: creations.some(item => item.id === local.activeCreationId) ? local.activeCreationId : creations[0]?.id ?? null }
}

/** Explicit whitelist: controllers, credentials and unrelated transient values never enter IndexedDB. */
function storedGeneration(generation: Generation): Generation {
  const { id, status, progress, imageUrl, prompt, timestamp, error, creationId, version, parentVersionId, model, modelLabel, thinkingLevel, resolution, useGrounding, aspectRatio, mode, runStatus, submittedDraftRevision, quality, document } = generation
  return { id, status, progress, imageUrl, prompt, timestamp, error, creationId, version, parentVersionId, model, modelLabel, thinkingLevel, resolution, useGrounding, aspectRatio, mode, runStatus, submittedDraftRevision, quality, document }
}

export function workspaceSnapshot(workspace: CreativeWorkspace): CreativeWorkspace {
  return { schema: 1, revision: workspace.revision, lastWriteId: workspace.lastWriteId, activeCreationId: workspace.activeCreationId, creations: workspace.creations.map(creation => ({
    id: creation.id, title: creation.title, remoteRevision: creation.remoteRevision, localOnly: creation.localOnly, creationUnknown: creation.creationUnknown, createdAt: creation.createdAt, updatedAt: creation.updatedAt,
    selectedVersionId: creation.selectedVersionId, unread: creation.unread,
    draftRevision: creation.draftRevision, pendingDraftRevision: creation.pendingDraftRevision,
    draft: { prompt: creation.draft.prompt, documentName: creation.draft.documentName, documentText: creation.draft.documentText, documentFile: creation.draft.documentFile, selectedMappingId: creation.draft.selectedMappingId, aspectRatio: creation.draft.aspectRatio, quality: creation.draft.quality, useUrls: creation.draft.useUrls, image1: creation.draft.image1, image2: creation.draft.image2, image1Url: creation.draft.image1Url, image2Url: creation.draft.image2Url },
    versions: creation.versions.map(storedGeneration),
  })) }
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)) }
function validGeneration(value: unknown): value is Generation {
  return object(value) && typeof value.id === "string" && typeof value.prompt === "string" && typeof value.timestamp === "number" && Number.isFinite(value.timestamp) && ["loading", "complete", "error"].includes(String(value.status)) && (value.imageUrl === null || typeof value.imageUrl === "string")
}
function restoreFile(value: unknown, name: string): File | null {
  if (value === null || value === undefined) return null
  if (typeof File !== "undefined" && value instanceof File) return value
  if (typeof Blob !== "undefined" && value instanceof Blob) return new File([value], name, { type: value.type })
  throw new Error("参考图记录格式无效。")
}

export function restoreWorkspace(value: unknown): CreativeWorkspace {
  if (!object(value) || value.schema !== 1 || !Array.isArray(value.creations) || !Number.isInteger(value.revision) || (value.revision as number) < 0) throw new Error("创作记录版本不兼容或已损坏，已停止覆盖原记录。")
  const ids = new Set<string>()
  const creations: Creation[] = value.creations.map(item => {
    if (!object(item) || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.title !== "string" || !object(item.draft) || !Array.isArray(item.versions) || !item.versions.every(validGeneration)) throw new Error("创作记录格式无效，已停止覆盖原记录。")
    ids.add(item.id)
    const draft = item.draft
    for (const key of ["prompt", "selectedMappingId", "aspectRatio", "image1Url", "image2Url"]) if (typeof draft[key] !== "string") throw new Error("草稿记录格式无效。")
    if (draft.documentName !== undefined && typeof draft.documentName !== "string") throw new Error("文档名称记录格式无效。")
    if (draft.documentText !== undefined && typeof draft.documentText !== "string") throw new Error("文档内容记录格式无效。")
    if (typeof draft.useUrls !== "boolean" || !QUALITIES.has(String(draft.quality))) throw new Error("草稿参数格式无效。")
    const versionIds = new Set<string>()
    const versions = item.versions.map((generation: Generation) => {
      if (versionIds.has(generation.id)) throw new Error("版本记录存在重复标识。")
      versionIds.add(generation.id)
      const restored = storedGeneration(generation)
      return restored.status === "loading" ? { ...restored, ...(restored.runStatus ? { runStatus: "unknown" as const } : {}), status: "error" as const, progress: 0, error: UNKNOWN_REQUEST_MESSAGE } : restored
    })
    const completed = versions.filter(version => version.status === "complete" && version.imageUrl)
    const selectedVersionId = completed.some(version => version.id === item.selectedVersionId) ? item.selectedVersionId as string : completed[0]?.id ?? null
    return {
      id: item.id, title: item.title, remoteRevision: typeof item.remoteRevision === "number" ? item.remoteRevision : undefined, localOnly: item.localOnly === true, creationUnknown: item.creationUnknown === true, createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(), updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
      draft: { prompt: draft.prompt as string, documentName: typeof draft.documentName === "string" ? draft.documentName : "", documentText: typeof draft.documentText === "string" ? draft.documentText : "", documentFile: restoreFile(draft.documentFile, typeof draft.documentName === "string" && draft.documentName ? draft.documentName : "document.bin"), selectedMappingId: draft.selectedMappingId as string, aspectRatio: draft.aspectRatio as string, quality: draft.quality as CreationDraft["quality"], useUrls: draft.useUrls, image1: restoreFile(draft.image1, "reference-1.png"), image2: restoreFile(draft.image2, "reference-2.png"), image1Url: draft.image1Url as string, image2Url: draft.image2Url as string },
      selectedVersionId, versions, unread: Boolean(item.unread), draftRevision: Number.isInteger(item.draftRevision) ? item.draftRevision as number : 0, pendingDraftRevision: null,
    }
  })
  return { schema: 1, revision: value.revision as number, ...(typeof value.lastWriteId === "string" ? { lastWriteId: value.lastWriteId } : {}), creations, activeCreationId: creations.some(creation => creation.id === value.activeCreationId) ? value.activeCreationId as string : creations[0]?.id ?? null }
}

type EmergencyDraft = Omit<CreationDraft, "image1" | "image2" | "image1Url" | "image2Url" | "documentFile"> & { image1Url?: string; image2Url?: string }
export interface EmergencyDraftEntry {
  id: string
  title: string
  createdAt: number
  draftRevision: number
  isNew: boolean
  localOnly?: boolean
  baseVersionId: string | null
  draft: EmergencyDraft
  image1Change?: { revision: number; hasFile: boolean }
  image2Change?: { revision: number; hasFile: boolean }
  documentChange?: { revision: number; hasFile: boolean }
}

/** Synchronous emergency storage contains only draft text/parameters, never files or inline image data. */
export function emergencyDraftEntry(creation: Creation, previous?: Creation, earlier?: EmergencyDraftEntry): EmergencyDraftEntry {
  const { prompt, documentName, documentText, selectedMappingId, aspectRatio, quality, useUrls, image1Url, image2Url } = creation.draft
  return {
    id: creation.id, title: creation.title, localOnly: creation.localOnly, createdAt: creation.createdAt, draftRevision: creation.draftRevision,
    isNew: earlier?.isNew ?? !previous,
    baseVersionId: creation.selectedVersionId,
    draft: { prompt, documentName, documentText, selectedMappingId, aspectRatio, quality, useUrls, ...(!/^data:/i.test(image1Url) ? { image1Url } : {}), ...(!/^data:/i.test(image2Url) ? { image2Url } : {}) },
    image1Change: creation.draft.image1 !== previous?.draft.image1 ? { revision: creation.draftRevision, hasFile: Boolean(creation.draft.image1) } : earlier?.image1Change,
    image2Change: creation.draft.image2 !== previous?.draft.image2 ? { revision: creation.draftRevision, hasFile: Boolean(creation.draft.image2) } : earlier?.image2Change,
    documentChange: creation.draft.documentFile !== previous?.draft.documentFile ? { revision: creation.draftRevision, hasFile: Boolean(creation.draft.documentFile) } : earlier?.documentChange,
  }
}

export function serializeEmergencyDrafts(baseRevision: number, pendingWriteId: string | null, entries: EmergencyDraftEntry[], activeCreationId?: string | null): string {
  return JSON.stringify({ schema: 1, baseRevision, pendingWriteId, entries, activeCreationId })
}

export function recoverEmergencyDrafts(workspace: CreativeWorkspace, raw: string | null, remote: PrivateCreation[] = []): { workspace: CreativeWorkspace; referencesNeedReselect: boolean } {
  const unchanged = { workspace, referencesNeedReselect: false }
  if (!raw) return unchanged
  let saved: unknown
  try { saved = JSON.parse(raw) } catch { return unchanged }
  if (!object(saved) || saved.schema !== 1 || !Number.isInteger(saved.baseRevision) || !Array.isArray(saved.entries)) return unchanged
  const ownPendingSave = typeof saved.pendingWriteId === "string" && workspace.revision === (saved.baseRevision as number) + 1 && workspace.lastWriteId === saved.pendingWriteId
  if (workspace.revision !== saved.baseRevision && !ownPendingSave) return unchanged
  let restored = workspace
  let referencesNeedReselect = false
  for (const value of saved.entries) {
    if (!object(value) || typeof value.id !== "string" || !Number.isInteger(value.draftRevision) || !object(value.draft) || (value.baseVersionId !== null && typeof value.baseVersionId !== "string")) continue
    const draft = value.draft
    if (!["prompt", "selectedMappingId", "aspectRatio"].every(key => typeof draft[key] === "string") || typeof draft.useUrls !== "boolean" || !QUALITIES.has(String(draft.quality))) continue
    let current = restored.creations.find(creation => creation.id === value.id)
    // The first device snapshot may never have reached IDB. A current authenticated
    // server record can supply its baseline without importing local image history.
    if (!current) {
      const server = remote.find(creation => creation.id === value.id)
      if (server) {
        current = mergePrivateWorkspace(emptyWorkspace(), [server]).creations[0]
        restored = { ...restored, creations: [...restored.creations, current] }
      }
    }
    // A draft cannot be recovered against a different image, including a result whose metadata was not saved yet.
    if (value.baseVersionId !== null && !current?.versions.some(version => version.id === value.baseVersionId && version.status === "complete" && version.imageUrl)) continue
    if (!current) {
      if (value.isNew !== true || typeof value.title !== "string" || typeof value.createdAt !== "number") continue
      current = newCreation({}, value.id, value.createdAt)
      current.title = value.title
      current.localOnly = value.localOnly === true
      restored = { ...restored, creations: [current, ...restored.creations], activeCreationId: restored.activeCreationId ?? current.id }
    } else if (current.draftRevision > (value.draftRevision as number)) continue
    const recovered: CreationDraft = { ...current.draft, prompt: draft.prompt as string, documentName: typeof draft.documentName === "string" ? draft.documentName : "", documentText: typeof draft.documentText === "string" ? draft.documentText : "", documentFile: current.draft.documentFile, selectedMappingId: draft.selectedMappingId as string, aspectRatio: draft.aspectRatio as string, quality: draft.quality as CreationDraft["quality"], useUrls: draft.useUrls }
    for (const key of ["image1Url", "image2Url"] as const) if (typeof draft[key] === "string" && !/^data:/i.test(draft[key])) recovered[key] = draft[key]
    for (const slot of [1, 2] as const) {
      const change = value[`image${slot}Change`]
      if (object(change) && typeof change.revision === "number" && change.revision > current.draftRevision) {
        recovered[slot === 1 ? "image1" : "image2"] = null
        referencesNeedReselect ||= change.hasFile === true
      }
    }
    const documentChange = value.documentChange
    if (object(documentChange) && typeof documentChange.revision === "number" && documentChange.revision > current.draftRevision) {
      recovered.documentFile = null
      referencesNeedReselect ||= documentChange.hasFile === true
    }
    restored = changeCreation(restored, current.id, creation => ({ ...creation, selectedVersionId: value.baseVersionId as string | null, draft: recovered, draftRevision: value.draftRevision as number }))
  }
  if (restored !== workspace && typeof saved.activeCreationId === "string" && restored.creations.some(creation => creation.id === saved.activeCreationId)) restored = { ...restored, activeCreationId: saved.activeCreationId }
  return { workspace: restored, referencesNeedReselect }
}

function legacyReference(value: unknown, name: string): File | null {
  if (typeof value !== "string") return null
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i)
  if (!match) return null
  try {
    const binary = atob(match[2])
    return new File([Uint8Array.from(binary, character => character.charCodeAt(0))], name, { type: match[1] })
  } catch { return null }
}

function legacyCompletedGenerations(historyRaw: string | null): Generation[] {
  const history: unknown = historyRaw ? JSON.parse(historyRaw) : []
  if (!Array.isArray(history)) throw new Error("旧记录格式无法识别，原始数据已保留。")
  const usedIds = new Set<string>()
  return history.filter(validGeneration).filter(generation => {
    if (generation.status !== "complete" || !generation.imageUrl || usedIds.has(generation.id)) return false
    usedIds.add(generation.id)
    return true
  }).sort((a, b) => b.timestamp - a.timestamp)
}

function legacyCreations(generations: Generation[], makeId: () => string): Creation[] {
  return generations.map((generation, index) => {
    const creation = newCreation({}, makeId(), generation.timestamp)
    creation.title = generation.prompt.replace(/\s+/g, " ").trim().slice(0, 24) || `历史图片 ${index + 1}`
    creation.versions = [{ ...storedGeneration(generation), creationId: creation.id, version: 1, parentVersionId: null }]
    creation.selectedVersionId = generation.id
    creation.draft.aspectRatio = generation.aspectRatio || "square"
    return creation
  })
}

/** Old app tabs may still append to the legacy history after the first migration. */
export function mergeLegacyHistory(workspace: CreativeWorkspace, historyRaw: string | null, makeId: () => string = () => crypto.randomUUID()): CreativeWorkspace {
  const knownIds = new Set(workspace.creations.flatMap(creation => creation.versions.map(version => version.id)))
  const imported = legacyCreations(legacyCompletedGenerations(historyRaw).filter(generation => !knownIds.has(generation.id)), makeId)
  if (!imported.length) return workspace
  return { ...workspace, creations: [...imported, ...workspace.creations], activeCreationId: workspace.activeCreationId ?? imported[0].id }
}

export function migrateLegacyWorkspace(historyRaw: string | null, draftRaw: string | null, now = Date.now(), makeId: () => string = () => crypto.randomUUID()): CreativeWorkspace {
  const oldDraft: unknown = draftRaw ? JSON.parse(draftRaw) : null
  if (oldDraft !== null && !object(oldDraft)) throw new Error("旧草稿格式无法识别，原始数据已保留。")
  const creations = legacyCreations(legacyCompletedGenerations(historyRaw), makeId)
  if (!creations.length) creations.push(newCreation({}, makeId(), now))
  if (object(oldDraft)) {
    const draft = creations[0].draft
    for (const key of ["prompt", "selectedMappingId", "aspectRatio", "image1Url", "image2Url"] as const) if (typeof oldDraft[key] === "string") draft[key] = oldDraft[key]
    draft.useUrls = oldDraft.useUrls === true
    if (QUALITIES.has(String(oldDraft.quality))) draft.quality = oldDraft.quality as CreationDraft["quality"]
    if (!draft.useUrls) {
      draft.image1 = legacyReference(oldDraft.image1Preview, "reference-1.png")
      draft.image2 = legacyReference(oldDraft.image2Preview, "reference-2.png")
    }
  }
  return { schema: 1, revision: 0, creations, activeCreationId: creations[0].id }
}

export class WorkspaceConflictError extends Error {}

/** A new account never imports the anonymous demo or another account's drafts. */
export function accountStorageKey(base: string, accountId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw new Error("账号标识无效，无法恢复草稿。")
  return `${base}:account:${accountId}`
}

function openDatabase(accountId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("浏览器不支持创作保存。")); return }
    const request = indexedDB.open(accountStorageKey(DATABASE, accountId), 1)
    let rejected = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onerror = () => { rejected = true; reject(request.error || new Error("无法打开创作记录。")) }
    request.onblocked = () => { rejected = true; reject(new Error("另一标签页正在更新创作记录，请关闭旧页面后重试。")) }
    request.onsuccess = () => {
      if (rejected) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
  })
}

export async function readWorkspace(accountId: string): Promise<unknown> {
  const database = await openDatabase(accountId)
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, "readonly")
      const request = transaction.objectStore(STORE).get(KEY)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally { database.close() }
}

/** Atomic revision check prevents another open tab from silently overwriting this one's work. */
export async function writeWorkspace(workspace: CreativeWorkspace, expectedRevision: number, writeId: string, accountId: string): Promise<number> {
  const database = await openDatabase(accountId)
  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite")
      const store = transaction.objectStore(STORE)
      let failure: unknown
      const request = store.get(KEY)
      request.onsuccess = () => {
        const existing = request.result
        if ((existing !== undefined && (!object(existing) || existing.schema !== 1)) || (existing?.revision ?? 0) !== expectedRevision) {
          failure = new WorkspaceConflictError("另一标签页已更新创作。为避免覆盖，当前修改暂留在本页；请先保留未保存的输入，再刷新。")
          transaction.abort()
          return
        }
        try {
          store.put({ ...workspaceSnapshot(workspace), revision: expectedRevision + 1, lastWriteId: writeId }, KEY)
        } catch (error) {
          failure = error
          transaction.abort()
        }
      }
      request.onerror = () => { failure = request.error }
      transaction.oncomplete = () => resolve(expectedRevision + 1)
      transaction.onerror = () => { failure ??= transaction.error }
      transaction.onabort = () => reject(failure || transaction.error || new Error("创作保存失败。"))
    })
  } finally { database.close() }
}
