"use client"

import { memo, useEffect, useCallback, useState, type ReactNode } from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ProgressBar } from "./progress-bar"
import { Pin, PinOff, Copy, Download, ImageIcon, RotateCw } from "lucide-react"
import type { Generation } from "./types"

interface OutputSectionProps {
  selectedGeneration: Generation | undefined
  pendingGeneration?: Generation
  generations: Generation[]
  selectedGenerationId: string | null
  setSelectedGenerationId: (id: string) => void
  imageLoaded: boolean
  setImageLoaded: (loaded: boolean) => void
  onCancelGeneration: (id: string) => void
  onDeleteGeneration: (id: string) => void
  onOpenFullscreen: () => void
  onLoadAsInput?: () => void
  onCopy: () => void
  onDownload: () => void
  onOpenInNewTab: () => void
  onImageReady: (id: string) => void
  onImageError: (id: string) => void
  annotationTools?: ReactNode
  annotationOverlay?: ReactNode
}

const ActionButtons = memo(function ActionButtons({ onCopy, onDownload, pinned, onTogglePin }: {
  onCopy: () => void
  onDownload: () => void
  pinned: boolean
  onTogglePin: () => void
}) {
  return <div className="flex items-center gap-1.5">
    <Button type="button" onClick={onCopy} variant="outline" size="sm" className="h-8 border-gray-600 bg-black/80 px-2 text-xs text-white backdrop-blur-sm hover:bg-black/95" title="复制到剪贴板"><Copy className="size-3.5" /><span>复制</span></Button>
    <Button type="button" onClick={onDownload} variant="outline" size="sm" className="h-8 border-gray-600 bg-black/80 px-2 text-xs text-white backdrop-blur-sm hover:bg-black/95" title="下载图片"><Download className="size-3.5" /><span>下载</span></Button>
    <Button type="button" onClick={onTogglePin} variant="outline" size="sm" className={cn("hidden h-8 border-gray-600 px-2 text-xs backdrop-blur-sm md:flex", pinned ? "bg-white text-black hover:bg-gray-200" : "bg-black/80 text-white hover:bg-black/95")} aria-label={pinned ? "取消固定工具栏" : "固定工具栏"}>{pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</Button>
  </div>
})

export const OutputSection = memo(function OutputSection({
  selectedGeneration, pendingGeneration, generations, selectedGenerationId, setSelectedGenerationId,
  setImageLoaded, onCancelGeneration, onOpenFullscreen, onCopy, onDownload, onImageError, annotationTools, annotationOverlay,
}: OutputSectionProps) {
  const [pinned, setPinned] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const imageUrl = selectedGeneration?.imageUrl ?? null
  const complete = selectedGeneration?.status === "complete" && Boolean(imageUrl)
  const pendingParent = generations.find(generation => generation.id === pendingGeneration?.parentVersionId)

  useEffect(() => { try { setPinned(localStorage.getItem("toolbar_pinned") === "true") } catch {} }, [])
  useEffect(() => { setLoadError(false); setImageLoaded(false) }, [imageUrl, setImageLoaded])
  const togglePin = useCallback(() => setPinned(current => {
    const next = !current
    try { localStorage.setItem("toolbar_pinned", String(next)) } catch {}
    return next
  }), [])

  useEffect(() => {
    if (pendingGeneration) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = document.activeElement
      if (event.defaultPrevented || (target instanceof Element && target.closest("[data-annotation-canvas]"))) return
      if (target instanceof HTMLElement && (target.isContentEditable || ["TEXTAREA", "INPUT", "SELECT"].includes(target.tagName))) return
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      const completeVersions = generations.filter(generation => generation.status === "complete" && generation.imageUrl)
      if (completeVersions.length < 2) return
      const index = completeVersions.findIndex(generation => generation.id === selectedGenerationId)
      const next = index < 0 ? 0 : index + (event.key === "ArrowLeft" ? -1 : 1)
      if (next >= 0 && next < completeVersions.length) {
        event.preventDefault()
        setSelectedGenerationId(completeVersions[next].id)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [generations, selectedGenerationId, setSelectedGenerationId, pendingGeneration])

  const imageLoadFailed = () => {
    setLoadError(true)
    setImageLoaded(false)
    if (selectedGeneration) onImageError(selectedGeneration.id)
  }
  const reloadImage = () => { setLoadError(false); setReloadNonce(value => value + 1) }

  return (
    <div className="group/output relative flex h-full min-h-0 select-none flex-col gap-3">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="text-sm font-medium text-gray-300">{complete ? `当前图片 · V${selectedGeneration?.version ?? 1}` : "图片预览"}</p>
        {complete && !pendingGeneration && <p className="text-[11px] text-gray-500">下一轮将修改这张图</p>}
      </div>
      {annotationTools}
      <div className="relative min-h-[220px] flex-1 overflow-hidden rounded-md border border-white/10 bg-black/20">
        {imageUrl ? (
          <>
            {imageUrl.startsWith("data:") ? <img key={`${selectedGeneration?.id}-${reloadNonce}`} src={imageUrl} alt={`V${selectedGeneration?.version ?? 1}：${selectedGeneration?.prompt ?? "生成结果"}`} className="absolute inset-0 h-full w-full cursor-pointer object-contain" onLoad={() => { setImageLoaded(true); setLoadError(false) }} onError={imageLoadFailed} onClick={complete ? onOpenFullscreen : undefined} /> : <Image key={`${selectedGeneration?.id}-${reloadNonce}`} unoptimized src={imageUrl} alt={`V${selectedGeneration?.version ?? 1}：${selectedGeneration?.prompt ?? "生成结果"}`} fill priority sizes="(max-width: 1024px) 100vw, 55vw" className="cursor-pointer object-contain" onLoad={() => { setImageLoaded(true); setLoadError(false) }} onError={imageLoadFailed} onClick={complete ? onOpenFullscreen : undefined} />}
            {complete && !loadError && <div className={cn("absolute bottom-3 left-1/2 z-10 -translate-x-1/2 transition-all md:translate-y-2 md:opacity-0", pinned ? "md:translate-y-0 md:opacity-100" : "md:group-hover/output:translate-y-0 md:group-hover/output:opacity-100 md:focus-within:translate-y-0 md:focus-within:opacity-100")}><ActionButtons onCopy={onCopy} onDownload={onDownload} pinned={pinned} onTogglePin={togglePin} /></div>}
            {!loadError && annotationOverlay}
            {loadError && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 p-5 text-center"><ImageIcon className="size-8 text-gray-500" /><p className="text-sm text-gray-300">图片暂时无法加载，版本已保留。</p><Button type="button" variant="outline" onClick={reloadImage} className="border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"><RotateCw className="size-3.5" />重新加载图片</Button></div>}
          </>
        ) : <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-5 text-center"><ImageIcon className="size-10 text-gray-600" /><p className="text-sm text-gray-400">{pendingGeneration ? "正在生成首版图片" : "描述你的画面，开始这项创作"}</p></div>}
      </div>
      {pendingGeneration && <div className="shrink-0 rounded-md border border-white/15 bg-black/70 p-3">
        <p role="status" className="mb-2 text-center text-xs text-gray-300">{pendingParent?.version ? `正在基于 V${pendingParent.version} 修改` : "正在生成图片"}</p>
        <div className="h-24"><ProgressBar key={pendingGeneration.id} progress={pendingGeneration.progress} phase={pendingGeneration.phase || "sending"} onCancel={() => onCancelGeneration(pendingGeneration.id)} /></div>
      </div>}
    </div>
  )
})
