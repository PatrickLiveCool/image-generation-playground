"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Generation } from "../types"
import type { CreationDraft, CreativeWorkspace } from "@/lib/creation-types"
import {
  WorkspaceConflictError, activateCreation, addCreation, completeCreationGeneration, emptyWorkspace,
  EMERGENCY_DRAFT_KEY, emergencyDraftEntry, recoverEmergencyDrafts, serializeEmergencyDrafts, type EmergencyDraftEntry,
  failCreationGeneration, mergeLegacyHistory, migrateLegacyWorkspace, newCreation, patchCreationDraft, readWorkspace,
  renameCreation as renameWorkspaceCreation, restoreWorkspace, selectCreationVersion,
  startCreationGeneration, updateCreationGeneration, workspaceSnapshot, writeWorkspace,
} from "@/lib/creative-workspace"

export function useCreativeWorkspace() {
  const [workspace, setWorkspace] = useState<CreativeWorkspace>(emptyWorkspace)
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
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

  const saveEmergencyDrafts = useCallback(() => {
    try {
      if (!emergencyEntriesRef.current.size) sessionStorage.removeItem(EMERGENCY_DRAFT_KEY)
      else sessionStorage.setItem(EMERGENCY_DRAFT_KEY, serializeEmergencyDrafts(persistedRevisionRef.current, pendingWriteIdRef.current, [...emergencyEntriesRef.current.values()], stateRef.current.activeCreationId))
    } catch {
      if (mountedRef.current) setStorageError("临时草稿无法保存，刷新前请稍候让创作记录完成保存。")
    }
  }, [])

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
          const revision = await writeWorkspace(snapshot, persistedRevisionRef.current, writeId)
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
  }, [saveEmergencyDrafts])

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
    const hydrate = async () => {
      try {
        let raw = await readWorkspace()
        let restored: CreativeWorkspace | undefined
        let referencesNeedReselect = false
        for (let attempt = 0; attempt < 3; attempt++) {
          if (cancelled) return
          // Validate the canonical data before attempting to merge any legacy results.
          const canonical = raw === undefined ? undefined : restoreWorkspace(raw)
          const recovery = canonical ? recoverEmergencyDrafts(canonical, sessionStorage.getItem(EMERGENCY_DRAFT_KEY)) : undefined
          referencesNeedReselect = recovery?.referencesNeedReselect ?? false
          restored = canonical
            ? mergeLegacyHistory(recovery!.workspace, localStorage.getItem("img_gen_history"))
            : migrateLegacyWorkspace(localStorage.getItem("img_gen_history"), sessionStorage.getItem("draft_form_state"))
          if (!restored.creations.length) restored = addCreation(restored, newCreation())
          if (restored === canonical) break
          // Commit initial migration and late legacy imports before exposing them as ready.
          try {
            const writeId = crypto.randomUUID()
            restored.revision = await writeWorkspace(restored, canonical?.revision ?? 0, writeId)
            restored.lastWriteId = writeId
            break
          } catch (error) {
            if (!(error instanceof WorkspaceConflictError) || attempt === 2) throw error
            // Another tab may have migrated or edited the workspace. Merge against its latest state.
            raw = await readWorkspace()
          }
        }
        if (!restored) throw new Error("无法恢复创作记录。")
        if (cancelled) return
        persistedRevisionRef.current = restored.revision
        stateRef.current = restored
        writableRef.current = true
        readyRef.current = true
        emergencyEntriesRef.current.clear()
        saveEmergencyDrafts()
        setWorkspace(restored)
        setReady(true)
        setStorageError(referencesNeedReselect ? "最新文字草稿已恢复；刷新前未保存完成的参考图或文档需要重新选择。" : null)
      } catch (error) {
        if (cancelled) return
        writableRef.current = false
        readyRef.current = false
        setStorageError(error instanceof Error && /记录|草稿/.test(error.message)
          ? error.message
          : "无法恢复创作记录，原数据未被覆盖。请检查浏览器存储权限后刷新。")
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
      saveBeforeLeaving()
      mountedRef.current = false
      window.removeEventListener("pagehide", saveBeforeLeaving)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [flushSave, saveEmergencyDrafts])

  const createCreation = useCallback((initialDraft: Partial<CreationDraft> = {}): string => {
    if (!readyRef.current) return ""
    const creation = newCreation(initialDraft)
    commit(state => addCreation(state, creation), true, true)
    return creation.id
  }, [commit])
  const selectCreation = useCallback((id: string) => { commit(state => activateCreation(state, id), true, true) }, [commit])
  const renameCreation = useCallback((id: string, title: string) => { commit(state => renameWorkspaceCreation(state, id, title), true, true) }, [commit])
  const patchDraft = useCallback((id: string, patch: Partial<CreationDraft>) => { commit(state => patchCreationDraft(state, id, patch)) }, [commit])
  const selectVersion = useCallback((creationId: string, versionId: string) => { commit(state => selectCreationVersion(state, creationId, versionId), true, true) }, [commit])
  const startGeneration = useCallback((creationId: string, generation: Generation): boolean => commit(state => startCreationGeneration(state, creationId, generation), true, true), [commit])
  // Progress is transient; avoid rewriting large draft File values on every timer tick.
  const updateGeneration = useCallback((creationId: string, id: string, patch: Partial<Generation>) => { commit(state => updateCreationGeneration(state, creationId, id, patch), false) }, [commit])
  const completeGeneration = useCallback((creationId: string, id: string, result: { imageUrl: string }): boolean => commit(state => completeCreationGeneration(state, creationId, id, result), true, true), [commit])
  const failGeneration = useCallback((creationId: string, id: string, message: string): boolean => commit(state => failCreationGeneration(state, creationId, id, message), true, true), [commit])
  const getCreation = useCallback((id: string) => stateRef.current.creations.find(creation => creation.id === id), [])

  return {
    creations: workspace.creations,
    activeCreation: workspace.creations.find(creation => creation.id === workspace.activeCreationId),
    activeCreationId: workspace.activeCreationId,
    ready, storageError, createCreation, selectCreation, renameCreation, patchDraft, selectVersion,
    startGeneration, updateGeneration, completeGeneration, failGeneration, getCreation,
  }
}

export type CreativeWorkspaceController = ReturnType<typeof useCreativeWorkspace>
