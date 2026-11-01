"use client"

import dynamic from "next/dynamic"
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type { ClipboardEvent, DragEvent, ReactElement } from "react"
import { Settings2 } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"
import { resolveModelMapping } from "@/lib/model-mappings"
import { prepareReference } from "@/lib/prepare-reference"
import { isDocumentFile, validateDocumentFile } from "@/lib/document-context"
import type { Creation, CreationDraft } from "@/lib/creation-types"
import { useApiSettings } from "./hooks/use-api-settings"
import { useCreativeWorkspace, type CreativeWorkspaceController } from "./hooks/use-creative-workspace"
import { useCreationGeneration } from "./hooks/use-creation-generation"
import { useAspectRatio } from "./hooks/use-aspect-ratio"
import { useImageActions } from "./hooks/use-image-actions"
import { InputSection } from "./input-section"
import { OutputSection } from "./output-section"
import { CreationList } from "./creation-list"
import { CreationHistory } from "./creation-history"
import { ApiSettingsModal } from "./api-settings-modal"
import { ToastNotification } from "./toast-notification"

const Dithering = dynamic(() => import("@paper-design/shaders-react").then(mod => ({ default: mod.Dithering })), { ssr: false })
const MemoizedDithering = memo(Dithering)
const HowItWorksModal = lazy(() => import("./how-it-works-modal").then(mod => ({ default: mod.HowItWorksModal })))
const FullscreenViewer = lazy(() => import("./fullscreen-viewer").then(mod => ({ default: mod.FullscreenViewer })))
const noop = () => {}

type Toast = (message: string, type?: "success" | "error") => void

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
  const api = useApiSettings(accountId)
  const workspace = useCreativeWorkspace(accountId)
  const [showApiSettings, setShowApiSettings] = useState(false)
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
  const generation = useCreationGeneration(workspace, api.settings, api.mappings, showToast)
  const uploadTokens = useRef(new Map<string, symbol>())
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
    patchDraft(creationId, { documentName: "", documentText: "", documentFile: null })
  }, [patchDraft])
  const upload = useCallback(async (creationId: string, file: File, slot: 1 | 2) => {
    const creation = getCreation(creationId)
    if (!creation || creation.versions.some(version => version.status === "loading")) return
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
    try {
      validateDocumentFile(file)
      if (!mounted.current) return
      patchDraft(creationId, { documentName: file.name, documentText: "", documentFile: file })
      showToast(`已载入文档：${file.name}，提交时会保存到私有 COS`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : "读取文档失败。", "error")
    }
  }, [getCreation, patchDraft, showToast])

  const submit = useCallback((creationId: string) => {
    if ([...uploadTokens.current.keys()].some(key => key.startsWith(`${creationId}:`))) return
    void generation.generate(creationId)
  }, [generation.generate])
  const newCreation = () => {
    const draft = workspace.activeCreation?.draft
    workspace.createCreation(draft ? { selectedMappingId: draft.selectedMappingId, aspectRatio: draft.aspectRatio, quality: draft.quality } : {})
  }
  const activeCreationId = workspace.activeCreation?.id

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-black font-sans text-white">
      <div className="pointer-events-none fixed inset-0 opacity-25"><MemoizedDithering colorBack="#00000000" colorFront="#FFFFFF" speed={0.43} shape="wave" type="4x4" pxSize={3} scale={0.6} style={{ backgroundColor: "#000000", height: "100vh", width: "100vw" }} /></div>
      {toast && <ToastNotification message={toast.message} type={toast.type} />}
      <main className="relative z-10 flex min-h-0 w-full flex-1 flex-col p-2 md:p-4 lg:p-6">
        <header className="mb-3 flex shrink-0 items-center justify-between gap-3">
          <div><h1 className="text-lg font-semibold md:text-2xl">图像生成实验室</h1><p className="mt-1 text-xs text-gray-400">{api.isConfigured ? "你的 API · 持续创作" : "配置你的 API，开始创作"}</p></div>
          <button type="button" onClick={() => setShowApiSettings(true)} className="flex shrink-0 items-center gap-2 rounded-md border border-white/20 px-3 py-2 text-xs hover:bg-white/10"><Settings2 className="size-4" />API 设置</button>
        </header>
        {(api.storageError || workspace.storageError) && <div role="alert" className="mb-3 shrink-0 rounded-md border border-amber-300/30 bg-black/90 p-3 text-xs leading-relaxed text-amber-200">{workspace.storageError || api.storageError}</div>}
        {workspace.ready && workspace.activeCreation ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-md border border-white/10 bg-black/75 p-2 lg:flex-row lg:overflow-hidden">
            <aside className="shrink-0 lg:w-[180px] lg:border-r lg:border-white/10 lg:pr-2"><CreationList creations={workspace.creations} activeId={workspace.activeCreation.id} onSelect={workspace.selectCreation} onCreate={newCreation} onRename={workspace.renameCreation} /></aside>
            <CreationEditor key={workspace.activeCreation.id} creation={workspace.activeCreation} workspace={workspace} api={api} onOpenSettings={() => setShowApiSettings(true)} onToast={showToast} onUpload={upload} onClearImage={clearImage} onDocumentUpload={file => activeCreationId ? uploadDocument(activeCreationId, file) : Promise.resolve()} onClearDocument={() => { if (activeCreationId) clearDocument(activeCreationId) }} uploading={uploads.some(key => key.startsWith(`${workspace.activeCreationId}:`))} onGenerate={submit} onCancel={generation.cancel} />
          </div>
        ) : <div role="status" className="flex flex-1 items-center justify-center text-sm text-gray-400">{workspace.storageError ? "创作记录未能载入，原数据已保留。" : "正在恢复创作…"}</div>}
        <footer className="flex shrink-0 items-center justify-center gap-3 pt-3 text-center text-xs text-gray-400">
          <button type="button" onClick={() => setShowHelp(true)} className="hover:text-white">使用说明</button>
          {appVersion && <><span aria-hidden="true" className="text-white/25">·</span><span aria-label={`应用版本 ${appVersion}`}>{appVersion === "development" ? "开发版" : `版本 ${appVersion}`}</span></>}
        </footer>
      </main>
      <ApiSettingsModal open={showApiSettings} onOpenChange={setShowApiSettings} settings={api.settings} models={api.models} mappings={api.mappings} modelsSynced={api.modelsSynced} onSave={(settings, models, mappings, synced) => {
        api.saveSettings(settings, models, mappings, synced)
        showToast("API 配置已保存")
      }} />
      <Suspense fallback={null}>{showHelp && <HowItWorksModal open={showHelp} onOpenChange={setShowHelp} />}</Suspense>
    </div>
  )
}

interface EditorProps {
  creation: Creation
  workspace: CreativeWorkspaceController
  api: ReturnType<typeof useApiSettings>
  onOpenSettings: () => void
  onToast: Toast
  onUpload: (id: string, file: File, slot: 1 | 2) => Promise<void>
  onClearImage: (id: string, slot: 1 | 2) => void
  onDocumentUpload: (file: File) => Promise<void>
  onClearDocument: () => void
  uploading: boolean
  onGenerate: (id: string) => void
  onCancel: (id: string, generationId: string) => void
}

function CreationEditor({ creation, workspace, api, onOpenSettings, onToast, onUpload, onClearImage, onDocumentUpload, onClearDocument, uploading, onGenerate, onCancel }: EditorProps) {
  const draft = creation.draft
  const base = creation.versions.find(version => version.id === creation.selectedVersionId && version.status === "complete" && version.imageUrl)
  const pending = creation.versions.find(version => version.status === "loading")
  const selectedMapping = resolveModelMapping(api.mappings, draft.selectedMappingId)
  const { availableAspectRatios, closestAvailable } = useAspectRatio(selectedMapping?.modelId || "")
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
  const isMobile = useIsMobile()
  const referenceCount = draft.useUrls ? Number(Boolean(draft.image1Url.trim())) + Number(Boolean(draft.image2Url.trim())) : Number(Boolean(draft.image1)) + Number(Boolean(draft.image2))
  const canGenerate = api.isConfigured && Boolean(selectedMapping) && Boolean(draft.prompt.trim()) && !pending && !uploading && (!base || referenceCount <= 1)
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
      const target = document.activeElement
      const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      if (event.key === "Escape" && actions.showFullscreen) actions.closeFullscreen()
      if (typing) return
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
  const clearAll = () => {
    if (pending) return
    onClearImage(creation.id, 1); onClearImage(creation.id, 2); onClearDocument()
    patch({ prompt: "" })
    promptRef.current?.focus()
  }
  const changeMode = (useUrls: boolean) => {
    if (pending || useUrls === draft.useUrls) return
    onClearImage(creation.id, 1); onClearImage(creation.id, 2)
    patch({ useUrls })
  }
  const upload = (file: File, slot: 1 | 2) => onUpload(creation.id, file, slot)
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
    <div className="grid min-w-0 shrink-0 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(360px,35%)_minmax(0,1fr)]" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault() }} onDrop={drop}>
      <div className="contents lg:flex lg:min-h-0 lg:min-w-0 lg:flex-col lg:gap-3 lg:overflow-y-auto lg:pr-2">
        <InputSection mappings={api.mappings} apiMode={api.settings.apiMode} apiConfigured={api.isConfigured} onOpenApiSettings={onOpenSettings}
          prompt={draft.prompt} setPrompt={prompt => patch({ prompt })} aspectRatio={draft.aspectRatio} setAspectRatio={aspectRatio => patch({ aspectRatio })} availableAspectRatios={availableAspectRatios}
          selectedMappingId={draft.selectedMappingId} setSelectedMappingId={selectedMappingId => patch({ selectedMappingId })} quality={draft.quality} setQuality={quality => patch({ quality })}
          thinkingLevel="minimal" setThinkingLevel={noop} resolution="1K" setResolution={noop} useGrounding={false} setUseGrounding={noop}
          useUrls={draft.useUrls} setUseUrls={changeMode} image1Preview={image1Preview} image2Preview={image2Preview} image1={draft.image1} image1Url={draft.image1Url} image2Url={draft.image2Url}
          documentName={draft.documentName ?? ""} documentText={draft.documentText ?? ""} documentFile={draft.documentFile ?? null} onDocumentUpload={onDocumentUpload} onClearDocument={onClearDocument}
          canGenerate={canGenerate} hasImages={Boolean(base || referenceCount)} onGenerate={() => onGenerate(creation.id)} onToast={onToast} onClearAll={clearAll} onImageUpload={upload}
          onUrlChange={(url, slot) => { clearImage(slot); patch(slot === 1 ? { image1Url: url } : { image2Url: url }) }} onClearImage={clearImage}
          onKeyDown={event => { if ((event.shiftKey || event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); if (canGenerate) onGenerate(creation.id) } }} onPromptPaste={uploadPasted}
          onImageFullscreen={actions.openFullscreen} promptTextareaRef={promptRef} baseGeneration={base} pendingGeneration={pending} submitLabel={uploading ? "正在处理上传内容…" : base ? `修改 V${base.version ?? 1}` : "生成图片"} />
        {uploading && <p role="status" className="text-xs text-gray-400">正在处理上传内容，可切换创作；完成后会放回当前创作。</p>}
        <CreationHistory generations={creation.versions} selectedId={creation.selectedVersionId} pending={Boolean(pending)} onSelect={selectVersion} onCancel={id => onCancel(creation.id, id)} className="order-3 min-h-[140px] shrink-0 pb-2 lg:order-none" />
      </div>
      <div className="order-2 h-[420px] min-w-0 lg:order-none lg:h-auto lg:min-h-0">
        <OutputSection selectedGeneration={base} pendingGeneration={pending} generations={creation.versions} selectedGenerationId={creation.selectedVersionId} setSelectedGenerationId={selectVersion}
          imageLoaded={imageLoaded} setImageLoaded={setImageLoaded} onCancelGeneration={id => onCancel(creation.id, id)} onDeleteGeneration={noop}
          onOpenFullscreen={() => generatedImage && actions.openFullscreen(generatedImage.url)} onCopy={() => void actions.copyImageToClipboard(generatedImage)} onDownload={() => void actions.downloadImage(generatedImage)}
          onOpenInNewTab={() => actions.openImageInNewTab(generatedImage)} onImageReady={noop} onImageError={noop} />
      </div>
      <Suspense fallback={null}>{actions.showFullscreen && actions.fullscreenImageUrl && <FullscreenViewer imageUrl={actions.fullscreenImageUrl} onClose={actions.closeFullscreen} onNavigate={navigate} canNavigate={!pending && fullscreenIsVersion && completed.length > 1} />}</Suspense>
    </div>
  )
}
