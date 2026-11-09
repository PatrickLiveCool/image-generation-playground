"use client"

import dynamic from "next/dynamic"
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClipboardEvent, DragEvent, ReactElement } from "react"
import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@/components/ui/button"
import { resolveModelMapping } from "@/lib/model-mappings"
import { prepareReference } from "@/lib/prepare-reference"
import { isDocumentFile, validateDocumentFile } from "@/lib/document-context"
import type { Creation, CreationDraft } from "@/lib/creation-types"
import { createEmptyAnnotationSnapshot, type AnnotationDraft } from "@/lib/image-annotations"
import { buildCreationRequest } from "@/lib/creation-request"
import { privateRequest } from "@/lib/private-workspace-client"
import { useModelCatalog } from "./hooks/use-model-catalog"
import { useCreativeWorkspace, creationDeletionBlocked, type CreativeWorkspaceController } from "./hooks/use-creative-workspace"
import { useCreationGeneration } from "./hooks/use-creation-generation"
import { useAspectRatio } from "./hooks/use-aspect-ratio"
import { useImageActions } from "./hooks/use-image-actions"
import { InputSection } from "./input-section"
import { EditorLayout } from "./editor-layout"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { OutputSection } from "./output-section"
import { CreationList } from "./creation-list"
import { CreationHistory } from "./creation-history"
import { ToastNotification } from "./toast-notification"
import { AnnotationCanvas, AnnotationList, AnnotationTools, addCenterAnnotation, useAnnotationEditor } from "./annotation-editor"
import { useAnnotationMetadata } from "./hooks/use-annotation-metadata"

const Dithering = dynamic(() => import("@paper-design/shaders-react").then(mod => ({ default: mod.Dithering })), { ssr: false })
const MemoizedDithering = memo(Dithering)
const HowItWorksModal = lazy(() => import("./how-it-works-modal").then(mod => ({ default: mod.HowItWorksModal })))
const FullscreenViewer = lazy(() => import("./fullscreen-viewer").then(mod => ({ default: mod.FullscreenViewer })))
const noop = () => {}

type Toast = (message: string, type?: "success" | "error") => void

function hasCreationAnnotations(creation: Creation) {
  return Boolean(creation.selectedVersionId && creation.draft.annotationDrafts?.[creation.selectedVersionId]?.snapshot.marks.length)
}

function useFilePreview(file: File | null) {
  const [preview, setPreview] = useState("")
  useEffect(() => {
    if (!file) { setPreview(""); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  return preview
}

export function ImageCombiner({ accountId }: { accountId: string }): ReactElement {
  return <AccountImageCombiner key={accountId} accountId={accountId} />
}

function AccountImageCombiner({ accountId }: { accountId: string }): ReactElement {
  const api = useModelCatalog()
  const uploadTokens = useRef(new Map<string, symbol>())
  const hasPendingInput = useCallback((id: string) => [...uploadTokens.current.keys()].some(key => key.startsWith(`${id}:`)), [])
  const workspace = useCreativeWorkspace(accountId, hasPendingInput)
  const [showHelp, setShowHelp] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showToast = useCallback<Toast>((message, type = "success") => {
    clearTimeout(toastTimer.current)
    setToast({ message, type })
    toastTimer.current = setTimeout(() => setToast(null), 5000)
  }, [])
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  useEffect(() => {
    let cancelled = false
    fetch("/api/version", { cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<{ version?: unknown }> : null)
      .then(payload => {
        if (!cancelled && payload && typeof payload.version === "string" && payload.version.trim()) setAppVersion(payload.version)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const generation = useCreationGeneration(workspace, api.catalog, showToast)
  const [uploads, setUploads] = useState<string[]>([])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; uploadTokens.current.clear() }
  }, [])
  const refreshUploads = useCallback(() => { if (mounted.current) setUploads([...uploadTokens.current.keys()]) }, [])
  const { getCreation, patchDraft } = workspace

  const clearImage = useCallback((creationId: string, slot: 1 | 2) => {
    uploadTokens.current.delete(`${creationId}:${slot}`)
    refreshUploads()
    patchDraft(creationId, slot === 1 ? { image1: null, image1Url: "" } : { image2: null, image2Url: "" })
  }, [patchDraft, refreshUploads])
  const clearDocument = useCallback((creationId: string) => {
    uploadTokens.current.delete(`${creationId}:document`)
    refreshUploads()
    patchDraft(creationId, { documentName: "", documentText: "", documentFile: null, documentImageInspection: "unknown" })
  }, [patchDraft, refreshUploads])
  const upload = useCallback(async (creationId: string, file: File, slot: 1 | 2) => {
    const creation = getCreation(creationId)
    if (!creation || creation.versions.some(version => version.status === "loading")) return
    if (hasCreationAnnotations(creation)) { showToast("批注修改期间暂停添加补充参考图。", "error"); return }
    if (creation.selectedVersionId && slot === 2) { showToast("修改当前图片时，只能添加一张补充参考图。", "error"); return }
    const key = `${creationId}:${slot}`
    const token = Symbol(key)
    uploadTokens.current.set(key, token)
    refreshUploads()
    try {
      const prepared = await prepareReference(file)
      if (!mounted.current || uploadTokens.current.get(key) !== token) return
      // The creation and slot are captured before conversion, even if the user switches away.
      const latest = getCreation(creationId)
      if (!latest || latest.versions.some(version => version.status === "loading")) return
      if (hasCreationAnnotations(latest)) { showToast("已开始批注，本次参考图未加入。", "error"); return }
      patchDraft(creationId, {
        ...(latest.draft.useUrls ? { image1Url: "", image2Url: "", image1: null, image2: null } : {}),
        useUrls: false,
        ...(slot === 1 ? { image1: prepared, image1Url: "" } : { image2: prepared, image2Url: "" }),
      })
    } catch (error) {
      if (uploadTokens.current.get(key) === token) showToast(error instanceof Error ? error.message : "读取图片失败。", "error")
    } finally {
      if (uploadTokens.current.get(key) === token) uploadTokens.current.delete(key)
      refreshUploads()
    }
  }, [getCreation, patchDraft, refreshUploads, showToast])
  const uploadDocument = useCallback(async (creationId: string, file: File) => {
    const creation = getCreation(creationId)
    if (!creation || creation.versions.some(version => version.status === "loading")) return
    const key = `${creationId}:document`, token = Symbol(key)
    try {
      validateDocumentFile(file)
      if (!mounted.current) return
      patchDraft(creationId, { documentName: file.name, documentText: "", documentFile: file, documentImageInspection: "unknown" })
      uploadTokens.current.set(key, token); refreshUploads()
      const body = new FormData(); body.set("document", file)
      const value = await privateRequest("/api/documents/preview", { method: "POST", body }) as { document?: { text?: unknown; imageInspection?: unknown } }
      if (!mounted.current || uploadTokens.current.get(key) !== token || getCreation(creationId)?.draft.documentFile !== file) return
      const preview = value.document
      if (!preview || typeof preview.text !== "string" || !["none", "present", "unknown"].includes(String(preview.imageInspection))) throw new Error("文档检查未确认，原文件已保留；区域批注可改用纯 TXT。")
      patchDraft(creationId, { documentText: preview.text, documentImageInspection: preview.imageInspection as "none" | "present" | "unknown" })
      showToast(`已载入文档：${file.name}，提交时会保存到私有 COS`)
    } catch (error) {
      if (mounted.current && (!uploadTokens.current.has(key) || uploadTokens.current.get(key) === token)) showToast(error instanceof Error ? error.message : "文档检查失败，原文件已保留。", "error")
    } finally { if (uploadTokens.current.get(key) === token) uploadTokens.current.delete(key); refreshUploads() }
  }, [getCreation, patchDraft, showToast, refreshUploads])

  const submit = useCallback((creationId: string) => {
    if (workspace.lifecycleBlocked(creationId)) return
    if ([...uploadTokens.current.keys()].some(key => key.startsWith(`${creationId}:`))) return
    void generation.generate(creationId)
  }, [generation.generate])
  const newCreation = () => {
    const draft = workspace.activeCreation?.draft
    void workspace.createCreation(draft ? { selectedMappingId: draft.selectedMappingId, aspectRatio: draft.aspectRatio, quality: draft.quality } : {})
  }
  const activeCreationId = workspace.activeCreation?.id
  const deletionBlocked = (id: string) => {
    const creation = workspace.getCreation(id)
    if (!creation) return "创作列表已变化，请关闭后重新选择。"
    if (workspace.lifecycleBlocked(id)) return "删除操作尚未结束，请刷新创作核对。"
    if (uploads.some(key => key.startsWith(`${id}:`))) return "正在处理上传内容，请稍候再删除。"
    return creationDeletionBlocked(creation)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-black font-sans text-white">
      <div className="pointer-events-none fixed inset-0 opacity-25"><MemoizedDithering colorBack="#00000000" colorFront="#FFFFFF" speed={0.43} shape="wave" type="4x4" pxSize={3} scale={0.6} style={{ backgroundColor: "#000000", height: "100vh", width: "100vw" }} /></div>
      {toast && <ToastNotification message={toast.message} type={toast.type} />}
      <main className="relative z-10 flex min-h-0 w-full flex-1 flex-col p-2 md:p-4 lg:p-6">
        <header className="mb-3 flex shrink-0 items-center justify-between gap-3">
          <div><h1 className="text-lg font-semibold md:text-2xl">图像生成实验室</h1><p className="mt-1 text-xs text-gray-400">{api.isConfigured ? "选择模型，持续创作" : "请联系管理员配置可用模型"}</p></div>
          <div className="flex gap-2"><button type="button" disabled={workspace.remoteBusy} onClick={() => void workspace.refresh()} className="shrink-0 rounded-md border border-white/20 px-3 py-2 text-xs hover:bg-white/10 disabled:opacity-50">刷新创作</button><button type="button" onClick={() => void api.refresh()} className="shrink-0 rounded-md border border-white/20 px-3 py-2 text-xs hover:bg-white/10">刷新模型</button></div>
        </header>
        {(api.error || workspace.storageError) && <div role="alert" className="mb-3 shrink-0 rounded-md border border-amber-300/30 bg-black/90 p-3 text-xs leading-relaxed text-amber-200">{workspace.storageError || api.error}</div>}
        {workspace.deletions.length > 0 && <div aria-label="删除操作反馈" className="mb-3 max-h-40 shrink-0 space-y-2 overflow-y-auto">{workspace.deletions.map(item => <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-md border border-white/20 bg-neutral-950 px-3 py-2 text-xs">
          <span role="status">{item.state === "deleted" ? `已删除「${item.title}」，本会话可撤销。` : `「${item.title}」的${item.state === "delete-unknown" ? "删除" : "撤销"}结果待核对。`}{item.error && ` ${item.error}`}</span>
          {item.state === "deleted" && <button type="button" disabled={workspace.lifecycleBusy.includes(item.id)} onClick={() => void workspace.restoreCreation(item.id)} className="rounded border border-white/25 px-2 py-1 text-sky-200 disabled:opacity-50">{workspace.lifecycleBusy.includes(item.id) ? "正在撤销…" : "撤销删除"}</button>}
          {(item.state !== "deleted" || item.error) && <button type="button" disabled={workspace.remoteBusy || workspace.lifecycleBusy.includes(item.id)} onClick={() => void workspace.refresh()} className="rounded border border-white/25 px-2 py-1 disabled:opacity-50">核对状态</button>}
          {item.state === "deleted" && <button type="button" disabled={workspace.lifecycleBusy.includes(item.id)} aria-label={`关闭 ${item.title} 的撤销提示`} onClick={() => workspace.dismissDeletion(item.id)} className="ml-auto px-2 py-1 text-gray-400 disabled:opacity-50">关闭提示</button>}
        </div>)}</div>}
        {workspace.ready && workspace.activeCreation ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scroll-pb-44 rounded-md border border-white/10 bg-black/75 p-2 pb-44 lg:flex-row lg:overflow-hidden lg:scroll-pb-0 lg:pb-2">
            <aside className="shrink-0 lg:w-[180px] lg:border-r lg:border-white/10 lg:pr-2"><CreationList creations={workspace.creations} activeId={workspace.activeCreation.id} onSelect={workspace.selectCreation} onCreate={newCreation} onRename={workspace.renameCreation} onDelete={workspace.deleteCreation} deletionBlocked={deletionBlocked} /></aside>
            <div className="contents" inert={workspace.lifecycleBlocked(workspace.activeCreation.id) || undefined}>
            <CreationEditor key={workspace.activeCreation.id} creation={workspace.activeCreation} workspace={workspace} api={api} onToast={showToast} onUpload={upload} onClearImage={clearImage} onDocumentUpload={file => activeCreationId ? uploadDocument(activeCreationId, file) : Promise.resolve()} onClearDocument={() => { if (activeCreationId) clearDocument(activeCreationId) }} uploading={uploads.some(key => key.startsWith(`${workspace.activeCreationId}:`))} onGenerate={submit} onCancel={generation.cancel} onCheckStatus={generation.checkStatus} />
            </div>
          </div>
        ) : <div role="status" className="flex flex-1 items-center justify-center text-sm text-gray-400">{workspace.storageError ? "创作记录未能载入，原数据已保留。" : "正在恢复创作…"}</div>}
        <footer className="flex shrink-0 items-center justify-center gap-3 pt-3 text-center text-xs text-gray-400">
          <button type="button" onClick={() => setShowHelp(true)} className="hover:text-white">使用说明</button>
          {appVersion && <><span aria-hidden="true" className="text-white/25">·</span><span aria-label={`应用版本 ${appVersion}`}>{appVersion === "development" ? "开发版" : `版本 ${appVersion}`}</span></>}
        </footer>
      </main>
      <Suspense fallback={null}>{showHelp && <HowItWorksModal open={showHelp} onOpenChange={setShowHelp} />}</Suspense>
    </div>
  )
}

interface EditorProps {
  creation: Creation
  workspace: CreativeWorkspaceController
  api: ReturnType<typeof useModelCatalog>
  onToast: Toast
  onUpload: (id: string, file: File, slot: 1 | 2) => Promise<void>
  onClearImage: (id: string, slot: 1 | 2) => void
  onDocumentUpload: (file: File) => Promise<void>
  onClearDocument: () => void
  uploading: boolean
  onGenerate: (id: string) => void
  onCancel: (id: string, generationId: string) => void
  onCheckStatus: (id: string, generationId: string, repair?: boolean) => Promise<void>
}

function CreationEditor({ creation, workspace, api, onToast, onUpload, onClearImage, onDocumentUpload, onClearDocument, uploading, onGenerate, onCancel, onCheckStatus }: EditorProps) {
  const [pendingInputChange, setPendingInputChange] = useState<{ kind: "clear" } | { kind: "input-mode"; useUrls: boolean; upload?: { file: File; slot: 1 | 2 } } | null>(null)
  const inputChangeFocus = useRef<HTMLElement | null>(null)
  const draft = creation.draft
  const base = creation.versions.find(version => version.id === creation.selectedVersionId && version.status === "complete" && version.imageUrl)
  const pending = creation.versions.find(version => version.status === "loading")
  const selectedMapping = resolveModelMapping(api.mappings, draft.selectedMappingId)
  const { availableAspectRatios, closestAvailable } = useAspectRatio("", selectedMapping?.aspectRatios)
  const patch = useCallback((value: Partial<CreationDraft>) => workspace.patchDraft(creation.id, value), [creation.id, workspace.patchDraft])
  useEffect(() => {
    if (pending || !api.ready) return
    const supported = closestAvailable(draft.aspectRatio)
    if (supported !== draft.aspectRatio) patch({ aspectRatio: supported })
  }, [closestAvailable, draft.aspectRatio, patch, pending, api.ready])
  const file1Preview = useFilePreview(draft.image1)
  const file2Preview = useFilePreview(draft.image2)
  const image1Preview = draft.useUrls ? draft.image1Url : file1Preview
  const image2Preview = draft.useUrls ? draft.image2Url : file2Preview
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  const metadata = useAnnotationMetadata(base?.imageUrl, base?.id)
  const [annotationTool, setAnnotationTool] = useState<"rectangle" | "lasso" | "brush" | null>(null)
  const annotationDraft = useMemo(() => {
    if (!base) return undefined
    if (draft.annotationDrafts?.[base.id]) return draft.annotationDrafts[base.id]
    if (!metadata.metadata || metadata.metadata.pages !== 1) return undefined
    return { snapshot: createEmptyAnnotationSnapshot(base.id, { ...metadata.metadata, pages: 1 }), revision: 0, nextNumber: 1 }
  }, [base?.id, draft.annotationDrafts, metadata.metadata])
  const saveAnnotations = (value: AnnotationDraft) => patch({ annotationDrafts: { ...workspace.getCreation(creation.id)?.draft.annotationDrafts, [value.snapshot.baseVersionId]: value } })
  const annotationEditor = useAnnotationEditor(annotationDraft, saveAnnotations, `${creation.id}:${base?.id ?? ""}`)
  const hasAnnotations = Boolean(annotationDraft?.snapshot.marks.length)
  const annotationDisabledReason = !base ? undefined : pending ? "当前任务正在处理，暂不能绘制或切换基础版本。" : !imageLoaded ? "基准图尚未加载完成，暂不能绘制。" : metadata.error || (!metadata.metadata ? "正在读取原图尺寸与方向…" : annotationDraft && (["assetId", "width", "height", "orientation", "pages"] as const).some(key => annotationDraft.snapshot.image[key] !== metadata.metadata![key]) ? "批注与原图信息不匹配，原草稿已保留。" : undefined)
  useEffect(() => { setAnnotationTool(null) }, [base?.id])
  const isMobile = useIsMobile()
  const referenceCount = Number(Boolean(draft.image1 || draft.image1Url.trim())) + Number(Boolean(draft.image2 || draft.image2Url.trim()))
  const incompleteAnnotation = annotationDraft?.snapshot.marks.find(mark => !mark.instruction.trim())
  const referenceConflict = hasAnnotations && referenceCount > 0
  let submissionReason: string | undefined
  if (pending) submissionReason = "正在生成，可切换到其他创作；本轮输入会保留。"
  else if (uploading) submissionReason = "正在处理上传内容，请稍候。"
  else if (creation.creationUnknown) submissionReason = "创作是否建立尚未确认，请先刷新创作核对。"
  else if (!api.ready) submissionReason = "正在读取模型配置…"
  else if (!api.isConfigured) submissionReason = "当前暂无可用模型，请联系管理员完成配置。"
  else if (!selectedMapping) submissionReason = "请选择可用模型。"
  else if (hasAnnotations && annotationDisabledReason) submissionReason = annotationDisabledReason
  else if (incompleteAnnotation) submissionReason = `批注 ${incompleteAnnotation.number} 尚未填写说明。`
  else if (referenceConflict) submissionReason = "请移除补充参考图后生成，批注和修改要求会保留。"
  else if (!hasAnnotations && !draft.prompt.trim()) submissionReason = "请填写生成要求。"
  else { try { buildCreationRequest({ creation, catalog: api.catalog }) } catch (error) { submissionReason = error instanceof Error ? error.message : "请检查输入内容。" } }
  const canGenerate = !submissionReason
  const currentMode = base || referenceCount ? "image-editing" : "text-to-image"
  const generatedImage = base?.imageUrl ? { url: base.imageUrl, prompt: base.prompt } : null
  const actions = useImageActions({ isMobile: Boolean(isMobile), currentMode, onToast })
  // A keyed editor may unmount when switching creations while a preview is open.
  useEffect(() => () => { document.body.style.overflow = "" }, [])
  const selectVersion = useCallback((id: string) => {
    if (pending) return
    workspace.selectVersion(creation.id, id)
  }, [creation.id, pending, workspace.selectVersion])
  const completed = creation.versions.filter(version => version.status === "complete" && version.imageUrl)
  const fullscreenIsVersion = completed.some(version => version.imageUrl === actions.fullscreenImageUrl)
  useEffect(() => {
    if (actions.showFullscreen && fullscreenIsVersion && base?.imageUrl) actions.setFullscreenImageUrl(base.imageUrl)
  }, [base?.id, base?.imageUrl, actions.showFullscreen, fullscreenIsVersion, actions.setFullscreenImageUrl])
  const navigate = useCallback((direction: "prev" | "next") => {
    if (pending) return
    const versions = creation.versions.filter(version => version.status === "complete" && version.imageUrl)
    const index = versions.findIndex(version => version.imageUrl === actions.fullscreenImageUrl)
    if (index < 0 || versions.length < 2) return
    const next = versions[(index + (direction === "prev" ? -1 : 1) + versions.length) % versions.length]
    selectVersion(next.id)
    actions.setFullscreenImageUrl(next.imageUrl!)
  }, [creation.versions, actions.fullscreenImageUrl, actions.setFullscreenImageUrl, selectVersion, pending])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][data-state], [role="alertdialog"]')) return
      const target = document.activeElement
      const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      if (event.key === "Escape" && actions.showFullscreen) actions.closeFullscreen()
      if (typing || (target instanceof Element && target.closest("[data-annotation-canvas]"))) return
      if (actions.showFullscreen && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation()
        navigate(event.key === "ArrowLeft" ? "prev" : "next")
      }
      const visibleImage = actions.showFullscreen ? { url: actions.fullscreenImageUrl, prompt: "" } : generatedImage
      if ((event.metaKey || event.ctrlKey) && event.key === "d" && visibleImage) { event.preventDefault(); void actions.downloadImage(visibleImage) }
      if ((event.metaKey || event.ctrlKey) && event.key === "c" && visibleImage && !window.getSelection()?.toString()) { event.preventDefault(); void actions.copyImageToClipboard(visibleImage) }
      if (event.key.toLowerCase() === "f" && generatedImage && !event.metaKey && !event.ctrlKey) actions.openFullscreen(generatedImage.url)
    }
    document.addEventListener("keydown", handler, true)
    return () => document.removeEventListener("keydown", handler, true)
  }, [actions, generatedImage, navigate])
  const clearImage = (slot: 1 | 2) => { if (!pending) onClearImage(creation.id, slot) }
  const clearReferences = () => { clearImage(1); clearImage(2) }
  const locateIncompleteAnnotation = () => {
    if (!incompleteAnnotation) return
    annotationEditor.select(incompleteAnnotation.id)
    const field = document.getElementById(`annotation-instruction-${incompleteAnnotation.id}`)
    field?.scrollIntoView?.({ block: "center", behavior: "smooth" })
    field?.focus()
  }
  const clearAll = () => {
    if (pending) return
    onClearImage(creation.id, 1); onClearImage(creation.id, 2); onClearDocument()
    if (hasAnnotations) annotationEditor.change([])
    patch({ prompt: "" })
    inputChangeFocus.current = promptRef.current
  }
  const changeMode = (useUrls: boolean, trigger: HTMLButtonElement) => {
    if (pending || hasAnnotations || useUrls === draft.useUrls) return
    if (referenceCount > 0) { inputChangeFocus.current = trigger; setPendingInputChange({ kind: "input-mode", useUrls }); return }
    onClearImage(creation.id, 1); onClearImage(creation.id, 2)
    patch({ useUrls })
  }
  const confirmInputChange = () => {
    if (pending || !pendingInputChange) return
    if (pendingInputChange.kind === "clear") clearAll()
    else if (!hasAnnotations) {
      if (pendingInputChange.upload) void onUpload(creation.id, pendingInputChange.upload.file, pendingInputChange.upload.slot)
      else {
        onClearImage(creation.id, 1); onClearImage(creation.id, 2)
        patch({ useUrls: pendingInputChange.useUrls })
      }
    }
    setPendingInputChange(null)
  }
  const upload = (file: File, slot: 1 | 2) => {
    if (pending || pendingInputChange) return Promise.resolve()
    if (hasAnnotations) { onToast("批注修改期间暂停添加补充参考图。", "error"); return Promise.resolve() }
    if (draft.useUrls && referenceCount > 0) {
      inputChangeFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : promptRef.current
      setPendingInputChange({ kind: "input-mode", useUrls: false, upload: { file, slot } })
      return Promise.resolve()
    }
    return onUpload(creation.id, file, slot)
  }
  const uploadPasted = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (pending) return
    const file = Array.from(event.clipboardData.items).find(item => item.type.startsWith("image/"))?.getAsFile()
    if (!file) return
    event.preventDefault()
    const slot = base || !draft.image1 ? 1 : 2
    void upload(file, slot)
  }
  const drop = (event: DragEvent) => {
    if (event.defaultPrevented) return
    event.preventDefault()
    if (pending) return
    const file = event.dataTransfer.files[0]
    if (file) {
      if (isDocumentFile(file)) void onDocumentUpload(file)
      else void upload(file, base || !draft.image1 ? 1 : 2)
    }
  }

  return (
    <div className="flex min-w-0 shrink-0 flex-col lg:min-h-0 lg:flex-1" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault() }} onDrop={drop}>
      <EditorLayout input={<>
        {creation.creationUnknown && <p role="alert" className="text-xs text-amber-300">创作是否建立尚未确认，请先刷新创作核对，输入已保留。</p>}
        {api.ready && !api.error && draft.selectedMappingId && !selectedMapping && <p role="alert" className="mb-2 text-xs text-amber-300">之前选择的模型已被移除，请重新选择模型。</p>}
        <InputSection mappings={api.mappings} apiMode={api.apiMode} apiConfigured={api.isConfigured}
          prompt={draft.prompt} setPrompt={prompt => patch({ prompt })} aspectRatio={draft.aspectRatio} setAspectRatio={aspectRatio => patch({ aspectRatio })} availableAspectRatios={availableAspectRatios}
          selectedMappingId={draft.selectedMappingId} setSelectedMappingId={selectedMappingId => patch({ selectedMappingId })} quality={draft.quality} setQuality={quality => patch({ quality })}
          thinkingLevel="minimal" setThinkingLevel={noop} resolution="1K" setResolution={noop} useGrounding={false} setUseGrounding={noop}
          useUrls={draft.useUrls} setUseUrls={changeMode} image1Preview={image1Preview} image2Preview={image2Preview} image1={draft.image1} image1Url={draft.image1Url} image2Url={draft.image2Url}
          documentName={draft.documentName ?? ""} documentText={draft.documentText ?? ""} documentFile={draft.documentFile ?? null} onDocumentUpload={onDocumentUpload} onClearDocument={onClearDocument}
          hasImages={Boolean(base || referenceCount)} onToast={onToast} onClearAll={trigger => { if (!pending) { inputChangeFocus.current = trigger; setPendingInputChange({ kind: "clear" }) } }} onImageUpload={upload}
          onUrlChange={(url, slot) => { if (pending || hasAnnotations) return; clearImage(slot); patch(slot === 1 ? { image1Url: url } : { image2Url: url }) }} onClearImage={clearImage}
          onKeyDown={event => { if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && (event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); if (canGenerate) onGenerate(creation.id) } }} onPromptPaste={uploadPasted}
          onImageFullscreen={actions.openFullscreen} promptTextareaRef={promptRef} baseGeneration={base} pendingGeneration={pending}
          referenceCount={referenceCount} onClearReferences={clearReferences} hasAnnotations={hasAnnotations} annotationContent={<AnnotationList editor={annotationEditor} onComplete={() => setAnnotationTool(null)} />} />
      </>}
      history={<CreationHistory generations={creation.versions} selectedId={creation.selectedVersionId} pending={Boolean(pending)} onSelect={selectVersion} onCancel={id => onCancel(creation.id, id)} onCheckStatus={id => void onCheckStatus(creation.id, id)} onRepair={id => void onCheckStatus(creation.id, id, true)} onDownloadDocument={document => void actions.downloadDocument(document)} className="min-h-[140px] shrink-0 pb-2" />}
      preview={<OutputSection selectedGeneration={base} pendingGeneration={pending} generations={creation.versions} selectedGenerationId={creation.selectedVersionId} setSelectedGenerationId={selectVersion}
          imageLoaded={imageLoaded} setImageLoaded={setImageLoaded} onCancelGeneration={id => onCancel(creation.id, id)} onDeleteGeneration={noop}
          onOpenFullscreen={() => generatedImage && actions.openFullscreen(generatedImage.url)} onCopy={() => void actions.copyImageToClipboard(generatedImage)} onDownload={() => void actions.downloadImage(generatedImage)}
          onOpenInNewTab={() => actions.openImageInNewTab(generatedImage)} onImageReady={noop} onImageError={noop}
          annotationTools={base && <AnnotationTools editor={annotationEditor} disabledReason={annotationDisabledReason} tool={annotationTool} setTool={setAnnotationTool} addCenter={() => { if (!annotationDisabledReason) addCenterAnnotation(annotationEditor) }} onRetryMetadata={metadata.error ? metadata.retry : undefined} />}
          annotationOverlay={annotationDraft && <AnnotationCanvas editor={annotationEditor} tool={annotationTool} disabled={Boolean(annotationDisabledReason)} onComplete={() => setAnnotationTool(null)} />} />}
      actions={<section aria-label="生成操作" className="space-y-2 rounded-md border border-white/20 bg-black p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {base && <p className="text-xs text-gray-300">基于 V{base.version ?? 1}{hasAnnotations ? ` · ${annotationDraft!.snapshot.marks.length} 条批注` : ""}</p>}
        {submissionReason && <p id="generation-submission-reason" role="status" className="text-xs leading-relaxed text-amber-200">{submissionReason}</p>}
        {!pending && !uploading && <div className="flex gap-3">
          {incompleteAnnotation && <button type="button" onClick={locateIncompleteAnnotation} className="text-xs text-sky-200 underline underline-offset-4">去填写</button>}
          {referenceConflict && <button type="button" onClick={clearReferences} className="text-xs text-sky-200 underline underline-offset-4">移除参考图</button>}
        </div>}
        <Button type="button" onClick={() => onGenerate(creation.id)} disabled={!canGenerate} aria-describedby={submissionReason ? "generation-submission-reason" : undefined} className="h-11 w-full bg-white text-sm font-semibold text-black hover:bg-gray-200">{pending ? "生成中…" : uploading ? "正在处理上传内容…" : base ? "生成新版本" : "生成图片"}</Button>
      </section>} />
      <AlertDialog open={Boolean(pendingInputChange)} onOpenChange={open => { if (!open) setPendingInputChange(null) }}>
        <AlertDialogContent className="border-white/20 bg-neutral-950 text-white" onCloseAutoFocus={event => {
          event.preventDefault()
          const target = inputChangeFocus.current
          if (target?.isConnected) target.focus()
          else promptRef.current?.focus()
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingInputChange?.kind === "clear" ? "清空本轮输入？" : `切换为${pendingInputChange?.kind === "input-mode" && pendingInputChange.useUrls ? "链接" : "文件"}输入？`}</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-300">{pendingInputChange?.kind === "clear" ? "将清除本轮文字、背景文档、参考图和未提交批注；已保存的图片版本、基准图和模型设置会保留。" : "切换会移除当前参考图；本轮文字、背景文档、已保存版本和基准图会保留。"}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white">取消</AlertDialogCancel>
            <AlertDialogAction disabled={Boolean(pending)} onClick={confirmInputChange} className="bg-white text-black hover:bg-gray-200">{pendingInputChange?.kind === "clear" ? "确认清空" : "移除参考图并切换"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Suspense fallback={null}>{actions.showFullscreen && actions.fullscreenImageUrl && <FullscreenViewer imageUrl={actions.fullscreenImageUrl} onClose={actions.closeFullscreen} onNavigate={navigate} canNavigate={!pending && fullscreenIsVersion && completed.length > 1} />}</Suspense>
    </div>
  )
}
