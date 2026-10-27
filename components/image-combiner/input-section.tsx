"use client"

import type { ModelMapping, ProviderSettings } from "@/lib/api-provider-types"
import type React from "react"
import { memo, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FileText, Trash2, Settings2, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ImageUploadBox } from "./image-upload-box"
import { ModelSelector } from "./model-selector"
import { cn } from "@/lib/utils"
import { isImageFile } from "@/lib/image-utils"
import type { Generation, ThinkingLevel, Resolution, Quality } from "./types"

interface InputSectionProps {
  mappings: ModelMapping[]
  apiMode: ProviderSettings["apiMode"]
  apiConfigured: boolean
  onOpenApiSettings: () => void
  prompt: string
  setPrompt: (prompt: string) => void
  aspectRatio: string
  setAspectRatio: (ratio: string) => void
  availableAspectRatios: Array<{ value: string; label: string; icon: React.ReactNode }>
  selectedMappingId: string
  setSelectedMappingId: (id: string) => void
  thinkingLevel: ThinkingLevel
  setThinkingLevel: (level: ThinkingLevel) => void
  resolution: Resolution
  setResolution: (res: Resolution) => void
  quality: Quality
  setQuality: (q: Quality) => void
  useGrounding: boolean
  setUseGrounding: (use: boolean) => void
  useUrls: boolean
  setUseUrls: (use: boolean) => void
  image1Preview: string | null
  image2Preview: string | null
  image1: File | null
  image1Url: string
  image2Url: string
  documentName: string
  documentText: string
  documentFile: File | null
  canGenerate: boolean
  hasImages: boolean
  onGenerate: () => void
  onToast: (message: string, type?: "success" | "error") => void
  onClearAll: () => void
  onImageUpload: (file: File, slot: 1 | 2) => Promise<void>
  onDocumentUpload: (file: File) => Promise<void>
  onClearDocument: () => void
  onUrlChange: (url: string, slot: 1 | 2) => void
  onClearImage: (slot: 1 | 2) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPromptPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onImageFullscreen: (url: string) => void
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>
  baseGeneration?: Generation
  pendingGeneration?: Generation
  submitLabel: string
}

export const InputSection = memo(function InputSection({
  mappings, apiMode, apiConfigured, onOpenApiSettings,
  prompt, setPrompt, aspectRatio, setAspectRatio, availableAspectRatios,
  selectedMappingId, setSelectedMappingId, quality, setQuality,
  useUrls, setUseUrls, image1Preview, image2Preview, image1Url, image2Url, documentName, documentText, documentFile,
  canGenerate, onGenerate, onClearAll, onImageUpload, onUrlChange, onClearImage,
  onDocumentUpload, onClearDocument,
  onKeyDown, onPromptPaste, onImageFullscreen, promptTextareaRef,
  baseGeneration, pendingGeneration, submitLabel,
}: InputSectionProps) {
  const pending = Boolean(pendingGeneration)
  const editing = Boolean(baseGeneration?.imageUrl)
  const hasInput = Boolean(prompt.trim() || documentText.trim() || documentFile || image1Preview || image2Preview || image1Url || image2Url)
  const referenceSlots: Array<1 | 2> = editing && !image2Preview && !image2Url ? [1] : [1, 2]

  const uploadFile = useCallback((event: React.ChangeEvent<HTMLInputElement>, slot: 1 | 2) => {
    if (pending) return
    const file = event.target.files?.[0]
    if (file) { void onImageUpload(file, slot); event.target.value = "" }
  }, [pending, onImageUpload])
  const dropFile = useCallback((event: React.DragEvent, slot: 1 | 2) => {
    event.preventDefault()
    if (pending) return
    const file = event.dataTransfer.files[0]
    if (file && isImageFile(file)) void onImageUpload(file, slot)
  }, [pending, onImageUpload])
  const uploadDocument = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (pending) return
    const file = event.target.files?.[0]
    if (file) void onDocumentUpload(file)
    event.target.value = ""
  }, [pending, onDocumentUpload])
  const selectImage = useCallback((slot: 1 | 2) => {
    if (pending) return
    const preview = slot === 1 ? image1Preview : image2Preview
    if (preview) onImageFullscreen(preview)
    else document.getElementById(`file${slot}`)?.click()
  }, [pending, image1Preview, image2Preview, onImageFullscreen])

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {!apiConfigured && <button type="button" onClick={onOpenApiSettings} className="rounded-md border border-white/15 px-3 py-2 text-left text-xs text-gray-300 hover:bg-white/5">配置你的 Base URL 和 Token，开始使用 →</button>}
      {apiConfigured && !mappings.length && <button type="button" onClick={onOpenApiSettings} className="rounded-md border border-white/15 px-3 py-2 text-left text-xs text-gray-300 hover:bg-white/5">添加模型映射，设置你想显示的名称 →</button>}

      {editing && (
        <div className="flex items-center gap-3 rounded-md border border-white/20 bg-white/5 p-2.5">
          <button type="button" onClick={() => onImageFullscreen(baseGeneration!.imageUrl!)} aria-label={`查看基准图 V${baseGeneration?.version ?? 1}`} className="shrink-0 rounded focus-visible:outline-2 focus-visible:outline-white">
            {/* Existing stored image is displayed without creating an optimized disk copy. */}
            <img src={baseGeneration!.imageUrl!} alt="" className="h-12 w-12 rounded object-contain" />
          </button>
          <div className="min-w-0"><p className="text-sm font-medium text-white">基于 V{baseGeneration?.version ?? 1} 修改</p><p className="mt-1 text-[11px] leading-relaxed text-gray-400">当前大图会自动用于本轮修改。</p></div>
        </div>
      )}

      <fieldset disabled={pending} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0 disabled:opacity-70">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="creation-prompt" className="text-sm font-medium text-gray-300">{editing ? "修改要求" : "提示词"}</label>
          <Button type="button" onClick={onClearAll} disabled={pending || !hasInput} variant="outline" aria-label="清空输入" title="清空输入和补充参考图，保留已有版本" className="h-7 border-gray-600 bg-transparent px-2 text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-50"><Trash2 className="size-3.5" />清空</Button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ModelSelector value={selectedMappingId} onChange={id => { if (!pending) setSelectedMappingId(id) }} mappings={mappings} />
          <Select disabled={pending} value={aspectRatio} onValueChange={value => { if (!pending) setAspectRatio(value) }}>
            <SelectTrigger aria-label="选择宽高比" className="!h-9 w-[96px] border-gray-600 bg-black/50 px-2 text-xs text-white focus:ring-0 focus-visible:ring-0"><SelectValue placeholder="1:1" /></SelectTrigger>
            <SelectContent className="border-gray-600 bg-black/95 text-white">{availableAspectRatios.map(option => <SelectItem key={option.value} value={option.value} textValue={option.label} className="text-xs"><div className="flex items-center gap-2"><span>{option.icon}</span><span>{option.label}</span></div></SelectItem>)}</SelectContent>
          </Select>
          {apiMode === "images" && <Popover>
            <PopoverTrigger asChild><button type="button" disabled={pending} aria-label="画质设置" className="h-9 border border-gray-600 bg-black/50 px-2 text-gray-300 hover:border-gray-500 hover:text-white"><Settings2 className="size-4" /></button></PopoverTrigger>
            <PopoverContent align="end" className="w-64 space-y-2 border-gray-600 bg-black/95 p-3 text-white">
              <p className="text-xs text-gray-400">画质</p>
              <div className="inline-flex w-full border border-gray-600 bg-black/50">{(["auto", "low", "medium", "high"] as const).map(value => <button type="button" key={value} disabled={pending} onClick={() => { if (!pending) setQuality(value) }} className={cn("flex-1 px-2 py-1.5 text-xs", quality === value ? "bg-white text-black" : "text-gray-300 hover:text-white")}>{({ auto: "自动", low: "低", medium: "中", high: "高" })[value]}</button>)}</div>
            </PopoverContent>
          </Popover>}
        </div>
        <textarea
          id="creation-prompt"
          ref={promptTextareaRef}
          value={prompt}
          onChange={event => { if (!pending) setPrompt(event.target.value) }}
          onKeyDown={onKeyDown}
          onPaste={onPromptPaste}
          placeholder={editing ? "描述本轮要修改的内容，例如：把标题改为…，其余保持不变。" : "描述你想生成的画面…"}
          aria-label={editing ? "图片修改要求" : "图像生成提示词"}
          className="min-h-[110px] w-full resize-y select-text rounded-md border border-gray-600 bg-black/50 p-3 text-sm leading-relaxed text-white focus:border-white focus:outline-none disabled:cursor-wait"
          style={{ fontSize: "16px", WebkitUserSelect: "text", userSelect: "text" }}
        />

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-300">背景文档（可选）</p>
            <label htmlFor="creation-document" className={cn("inline-flex cursor-pointer items-center gap-1 rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:border-gray-400 hover:text-white", pending && "pointer-events-none opacity-50")}>
              <FileText className="size-3.5" />上传文档
            </label>
            <input id="creation-document" type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.pdf,.docx,text/plain,text/markdown,text/csv,application/json,text/html,application/xml,text/xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden" onChange={uploadDocument} />
          </div>
          {documentFile || documentText ? (
            <div className="flex items-start gap-2 rounded-md border border-blue-300/30 bg-blue-300/5 p-2 text-xs text-gray-300">
              <FileText className="mt-0.5 size-4 shrink-0 text-blue-200" />
              <div className="min-w-0 flex-1"><p className="truncate text-white">{documentName || "已上传文档"}</p><p className="mt-0.5 text-[11px] text-gray-400">{documentFile ? `${(documentFile.size / 1024 / 1024).toFixed(1)} MB · 提交时保存到私有 COS，并提取文字与图片` : `${documentText.length} 字 · 作为提示词上下文发送`}</p></div>
              <button type="button" onClick={onClearDocument} disabled={pending} aria-label="移除背景文档" className="rounded p-1 text-gray-400 hover:text-white disabled:opacity-50"><X className="size-3.5" /></button>
            </div>
          ) : <p className="text-[11px] leading-relaxed text-gray-500">支持 TXT、MD、CSV、JSON、HTML、XML、PDF 和 DOCX，单个文档最大 10 MB。</p>}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-300">{editing ? "补充参考图（可选）" : "参考图片（可选）"}</p>
            <div className="inline-flex border border-gray-600 bg-black/50">
              <button type="button" title="切换输入方式会清空当前参考图" onClick={() => setUseUrls(false)} className={cn("px-2 py-1 text-xs", !useUrls ? "bg-white text-black" : "text-gray-300 hover:text-white")}>文件</button>
              <button type="button" title="切换输入方式会清空当前参考图" onClick={() => setUseUrls(true)} className={cn("px-2 py-1 text-xs", useUrls ? "bg-white text-black" : "text-gray-300 hover:text-white")}>链接</button>
            </div>
          </div>
          {editing && referenceSlots.length > 1 && <p className="text-[11px] leading-relaxed text-amber-300">基准图已自动加入，请保留一张补充参考图后提交。</p>}
          {useUrls ? (
            <div className="space-y-2">
              {referenceSlots.map(slot => {
                const value = slot === 1 ? image1Url : image2Url
                const label = editing ? (referenceSlots.length > 1 ? `补充参考图 ${slot} 的链接` : "补充参考图的链接") : slot === 1 ? "第一张图片的链接" : "第二张图片的链接"
                return <div key={slot} className="relative"><input type="url" value={value} onChange={event => { if (!pending) onUrlChange(event.target.value, slot) }} placeholder={label} aria-label={label} className="w-full select-text rounded-md border border-gray-600 bg-black/50 p-2 pr-8 text-xs text-white focus:border-white focus:outline-none" />{value && <button type="button" aria-label={`清空${label}`} onClick={() => onClearImage(slot)} className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-white"><Trash2 className="size-3.5" /></button>}</div>
              })}
            </div>
          ) : (
            <div className={cn("grid gap-2", referenceSlots.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
              {referenceSlots.map(slot => <div key={slot} className="min-w-0"><ImageUploadBox imageNumber={slot} preview={slot === 1 ? image1Preview : image2Preview} onDrop={event => dropFile(event, slot)} onClear={() => { if (!pending) onClearImage(slot) }} onSelect={() => selectImage(slot)} /><input id={`file${slot}`} type="file" accept="image/*,.heic,.heif" className="hidden" onChange={event => uploadFile(event, slot)} /></div>)}
            </div>
          )}
        </div>
        <Button type="button" onClick={onGenerate} disabled={pending || !canGenerate} className="h-11 w-full bg-white text-sm font-semibold text-black hover:bg-gray-200">{pending ? "生成中…" : submitLabel}</Button>
      </fieldset>
      {pending && <p role="status" className="text-xs leading-relaxed text-gray-400">正在生成，可切换到其他创作；本轮输入会保留。</p>}
    </div>
  )
})
