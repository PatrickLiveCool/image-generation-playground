"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createRemoteCreation, listPrivateWorkspace, renameRemoteCreation, PrivateWorkspaceError } from "@/lib/private-workspace-client"
import type { PrivateCreation, PrivateRun } from "@/lib/private-workspace-types"
import type { Generation } from "../types"
import type { CreationDraft, CreativeWorkspace } from "@/lib/creation-types"
import {
  DEFAULT_CREATION_TITLE, WorkspaceConflictError, accountStorageKey, activateCreation, addCreation, completeCreationGeneration, emptyWorkspace,
  EMERGENCY_DRAFT_KEY, emergencyDraftEntry, recoverEmergencyDrafts, serializeEmergencyDrafts, type EmergencyDraftEntry,
  failCreationGeneration, newCreation, patchCreationDraft, readWorkspace,
  renameCreation as renameWorkspaceCreation, restoreWorkspace, selectCreationVersion,
  startCreationGeneration, updateCreationGeneration, workspaceSnapshot, writeWorkspace,
  mergePrivateWorkspace, applyPrivateRun, markPrivateRunUnknown,
} from "@/lib/creative-workspace"

export function useCreativeWorkspace(accountId: string) {
  const emergencyKey = accountStorageKey(EMERGENCY_DRAFT_KEY, accountId)
  const [workspace, setWorkspace] = useState<CreativeWorkspace>(emptyWorkspace)
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const stateRef = useRef(workspace)
  const mountedRef = useRef(false)
  const readyRef = useRef(false)
  const writableRef = useRef(false)
  const persistedRevisionRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const savingRef = useRef(false)
  const saveRequestedRef = useRef(false)
  const emergencyEntriesRef = useRef(new Map<string, EmergencyDraftEntry>())
  const pendingWriteIdRef = useRef<string | null>(null)
  const lifetime = useRef<AbortController | null>(null)
  const creating = useRef(new Set<string>())
  const [remoteBusy, setRemoteBusy] = useState(false)
  const mutationEpoch = useRef(0)
  const refreshSequence = useRef(0)

  const saveEmergencyDrafts = useCallback(() => {
    try {
      if (!emergencyEntriesRef.current.size) sessionStorage.removeItem(emergencyKey)
      else sessionStorage.setItem(emergencyKey, serializeEmergencyDrafts(persistedRevisionRef.current, pendingWriteIdRef.current, [...emergencyEntriesRef.current.values()], stateRef.current.activeCreationId))
    } catch {
      if (mountedRef.current) setStorageError("临时草稿无法保存，刷新前请稍候让创作记录完成保存。")
    }
  }, [emergencyKey])

  const flushSave = useCallback(async () => {
    if (!readyRef.current || !writableRef.current) return
    saveRequestedRef.current = true
    if (savingRef.current) return
    savingRef.current = true
    try {
      while (saveRequestedRef.current && writableRef.current) {
        saveRequestedRef.current = false
        const snapshot = workspaceSnapshot(stateRef.current)
        const writeId = crypto.randomUUID()
        pendingWriteIdRef.current = writeId
        saveEmergencyDrafts()
        try {
          const revision = await writeWorkspace(snapshot, persistedRevisionRef.current, writeId, accountId)
          persistedRevisionRef.current = revision
          // Keep any newer edits made while this transaction was running.
          stateRef.current = { ...stateRef.current, revision, lastWriteId: writeId }
          pendingWriteIdRef.current = null
          for (const [id, entry] of emergencyEntriesRef.current) {
            const saved = snapshot.creations.find(creation => creation.id === id)
            if (saved && saved.draftRevision >= entry.draftRevision && saved.selectedVersionId === entry.baseVersionId) emergencyEntriesRef.current.delete(id)
          }
          saveEmergencyDrafts()
          if (mountedRef.current) {
            setWorkspace(stateRef.current)
            setStorageError(null)
          }
        } catch (error) {
          pendingWriteIdRef.current = null
          saveEmergencyDrafts()
          saveRequestedRef.current = false
          if (error instanceof WorkspaceConflictError) writableRef.current = false
          if (mountedRef.current) setStorageError(error instanceof WorkspaceConflictError
            ? error.message
            : "创作记录暂时无法保存，当前内容仍保留在本页。请勿关闭页面，并检查浏览器存储空间或权限。")
          break
        }
      }
    } finally { savingRef.current = false }
  }, [saveEmergencyDrafts, accountId])

  const scheduleSave = useCallback((immediate = false) => {
    clearTimeout(timerRef.current)
    if (immediate || !mountedRef.current) void flushSave()
    else timerRef.current = setTimeout(() => { void flushSave() }, 180)
  }, [flushSave])

  const commit = useCallback((change: (state: CreativeWorkspace) => CreativeWorkspace, persist = true, immediate = false): boolean => {
    if (!readyRef.current) return false
    const previous = stateRef.current
    const next = change(previous)
    if (next === previous) return false
    if (persist) mutationEpoch.current++
    for (const creation of next.creations) {
      const before = previous.creations.find(item => item.id === creation.id)
      if (!before || before.draftRevision !== creation.draftRevision || before.selectedVersionId !== creation.selectedVersionId) emergencyEntriesRef.current.set(creation.id, emergencyDraftEntry(creation, before, emergencyEntriesRef.current.get(creation.id)))
    }
    stateRef.current = next
    if (persist) saveEmergencyDrafts()
    if (mountedRef.current) setWorkspace(next)
    if (persist) scheduleSave(immediate)
    return true
  }, [scheduleSave, saveEmergencyDrafts])

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    const controller = new AbortController()
    lifetime.current = controller
    const hydrate = async () => {
      try {
        const [raw, remote] = await Promise.all([readWorkspace(accountId), listPrivateWorkspace(controller.signal)])
        if (cancelled) return
        const canonical = raw === undefined ? emptyWorkspace() : restoreWorkspace(raw)
        const recovery = recoverEmergencyDrafts(canonical, sessionStorage.getItem(emergencyKey), remote)
        let restored = mergePrivateWorkspace(recovery.workspace, remote)
        if (!restored.creations.length) restored = addCreation(restored, { ...newCreation(), localOnly: true })
        persistedRevisionRef.current = canonical.revision
        stateRef.current = restored
        writableRef.current = true
        readyRef.current = true
        // A recovered emergency copy survives until this exact draft is confirmed in IDB.
        emergencyEntriesRef.current = new Map(recovery.workspace !== canonical
          ? restored.creations.map(creation => [creation.id, emergencyDraftEntry(creation, canonical.creations.find(item => item.id === creation.id))])
          : [])
        setWorkspace(restored)
        setReady(true)
        setStorageError(recovery.referencesNeedReselect ? "最新文字草稿已恢复；未保存完成的参考图或文档需要重新选择。" : null)
        void flushSave()
      } catch (error) {
        if (cancelled) return
        writableRef.current = false
        readyRef.current = false
        setStorageError(error instanceof Error ? error.message : "无法恢复创作，请刷新重试。")
        setReady(false)
      }
    }
    void hydrate()
    const saveBeforeLeaving = () => { clearTimeout(timerRef.current); void flushSave() }
    const onVisibility = () => { if (document.visibilityState === "hidden") saveBeforeLeaving() }
    window.addEventListener("pagehide", saveBeforeLeaving)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelled = true
      controller.abort()
      saveBeforeLeaving()
      mountedRef.current = false
      window.removeEventListener("pagehide", saveBeforeLeaving)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [flushSave, saveEmergencyDrafts, accountId, emergencyKey])

  const acceptRemote = useCallback((remote: PrivateCreation) => {
    commit(state => {
      const merged = mergePrivateWorkspace(state, [remote], { preserveConfirmed: true }).creations.find(item => item.id === remote.id)!
      return { ...state, creations: state.creations.some(item => item.id === remote.id)
        ? state.creations.map(item => item.id === remote.id ? merged : item) : [merged, ...state.creations] }
    }, true, true)
  }, [commit])
  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal
    const sequence = ++refreshSequence.current
    const epoch = mutationEpoch.current
    setRemoteBusy(true)
    try {
      const remote = await listPrivateWorkspace(signal)
      if (signal?.aborted || sequence !== refreshSequence.current) return
      if (epoch !== mutationEpoch.current) {
        setRemoteError("刷新期间创作已有新变化，当前内容已保留；需要更新列表时请再次刷新。")
        return
      }
      if (!readyRef.current) { window.location.reload(); return }
      commit(state => {
        const merged = mergePrivateWorkspace(state, remote, { preserveConfirmed: true })
        return merged.creations.length ? merged : addCreation(merged, { ...newCreation(), localOnly: true })
      }, true, true)
      setRemoteError(null)
    } catch (error) {
      if (!signal?.aborted && sequence === refreshSequence.current) setRemoteError(error instanceof Error ? error.message : "刷新失败，草稿已保留。")
    } finally { if (!signal?.aborted && sequence === refreshSequence.current) setRemoteBusy(false) }
  }, [commit])
  const ensureRemoteCreation = useCallback(async (id: string, submittedPrompt?: string) => {
    const creation = stateRef.current.creations.find(item => item.id === id)
    if (!creation) throw new Error("创作已切换，请重新选择。")
    if (creation.remoteRevision !== undefined) return
    if (creation.creationUnknown) throw new Error("创作是否建立尚未确认，请先刷新创作核对。")
    if (creating.current.has(id)) throw new Error("正在建立创作，请稍候。")
    creating.current.add(id)
    const signal = lifetime.current?.signal
    try {
      const title = creation.title === DEFAULT_CREATION_TITLE && submittedPrompt?.trim()
        ? submittedPrompt.trim().split(/\r?\n/)[0].replace(/\s+/g, " ").slice(0, 24) : creation.title
      const remote = await createRemoteCreation(id, title, signal)
      if (signal?.aborted) throw new Error("页面已离开。")
      acceptRemote(remote)
      setRemoteError(null)
    } catch (error) {
      if (!signal?.aborted && (!(error instanceof PrivateWorkspaceError) || error.status === 0 || error.status >= 500)) {
        commit(state => ({ ...state, creations: state.creations.map(item => item.id === id ? { ...item, creationUnknown: true } : item) }), true, true)
      }
      throw error
    } finally { creating.current.delete(id) }
  }, [acceptRemote, commit])
  const createCreation = useCallback(async (initialDraft: Partial<CreationDraft> = {}): Promise<string> => {
    if (!readyRef.current || creating.current.size) return ""
    setRemoteBusy(true)
    try {
      const unsubmitted = stateRef.current.creations.find(item => item.localOnly)
      const draft = unsubmitted?.draft
      const hasInput = draft && Boolean(draft.prompt.trim() || draft.documentFile || draft.documentText?.trim() || draft.image1 || draft.image2 || draft.image1Url.trim() || draft.image2Url.trim())
      // Preserve an occupied first editor before opening another creation. Its inputs
      // remain device-local; creating the server record does not submit a generation.
      if (unsubmitted && hasInput) await ensureRemoteCreation(unsubmitted.id)
      const creation = unsubmitted && !hasInput ? unsubmitted : { ...newCreation(initialDraft), localOnly: true }
      commit(state => creation === unsubmitted ? activateCreation(state, creation.id) : addCreation(state, creation), true, true)
      await ensureRemoteCreation(creation.id)
      return creation.id
    } catch (error) {
      if (mountedRef.current) setRemoteError(error instanceof Error ? error.message : "创建结果未确认，请刷新核对。")
      return ""
    } finally { if (mountedRef.current) setRemoteBusy(false) }
  }, [commit, ensureRemoteCreation])
  const selectCreation = useCallback((id: string) => { commit(state => activateCreation(state, id), true, true) }, [commit])
  const renameCreation = useCallback(async (id: string, title: string) => {
    const signal = lifetime.current?.signal
    const validated = renameWorkspaceCreation(stateRef.current, id, title).creations.find(item => item.id === id)
    if (!validated) return
    await ensureRemoteCreation(id)
    const revision = stateRef.current.creations.find(item => item.id === id)?.remoteRevision
    if (revision === undefined) throw new Error("创作尚未建立，请刷新核对。")
    try {
      const remote = await renameRemoteCreation(id, revision, validated.title, signal)
      if (!signal?.aborted) acceptRemote(remote)
    } catch (error) {
      if (error instanceof PrivateWorkspaceError && error.status === 409) throw new Error("创作已在其他设备更新，当前草稿已保留；请刷新创作后重新命名。")
      throw error
    }
  }, [acceptRemote, ensureRemoteCreation])
  const patchDraft = useCallback((id: string, patch: Partial<CreationDraft>) => { commit(state => patchCreationDraft(state, id, patch)) }, [commit])
  const selectVersion = useCallback((creationId: string, versionId: string) => { commit(state => selectCreationVersion(state, creationId, versionId), true, true) }, [commit])
  const startGeneration = useCallback((creationId: string, generation: Generation): boolean => commit(state => startCreationGeneration(state, creationId, generation), true, true), [commit])
  // Progress is transient; avoid rewriting large draft File values on every timer tick.
  const updateGeneration = useCallback((creationId: string, id: string, patch: Partial<Generation>) => { commit(state => updateCreationGeneration(state, creationId, id, patch), false) }, [commit])
  const completeGeneration = useCallback((creationId: string, id: string, result: { imageUrl: string }): boolean => commit(state => completeCreationGeneration(state, creationId, id, result), true, true), [commit])
  const failGeneration = useCallback((creationId: string, id: string, message: string): boolean => commit(state => failCreationGeneration(state, creationId, id, message), true, true), [commit])
  const applyRun = useCallback((run: PrivateRun) => { commit(state => applyPrivateRun(state, run), true, true) }, [commit])
  const markUnknown = useCallback((creationId: string, id: string, message: string) => { commit(state => markPrivateRunUnknown(state, creationId, id, message), true, true) }, [commit])
  const getCreation = useCallback((id: string) => stateRef.current.creations.find(creation => creation.id === id), [])

  return {
    creations: workspace.creations,
    activeCreation: workspace.creations.find(creation => creation.id === workspace.activeCreationId),
    activeCreationId: workspace.activeCreationId,
    ready, storageError: remoteError || storageError, remoteBusy, refresh, ensureRemoteCreation, applyRun, markUnknown, createCreation, selectCreation, renameCreation, patchDraft, selectVersion,
    startGeneration, updateGeneration, completeGeneration, failGeneration, getCreation,
  }
}

export type CreativeWorkspaceController = ReturnType<typeof useCreativeWorkspace>
