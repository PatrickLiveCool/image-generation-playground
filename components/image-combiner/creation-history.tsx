"use client"

import Image from "next/image"
import { Loader2, AlertCircle, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Generation } from "./types"
import { AnnotationSnapshotPreview } from "./annotation-editor"

export interface CreationHistoryProps {
  generations: Generation[]
  selectedId: string | null
  pending: boolean
  onSelect: (id: string) => void
  onCancel: (id: string) => void
  onCheckStatus?: (id: string) => void
  onRepair?: (id: string) => void
  onDownloadDocument?: (document: NonNullable<Generation["document"]>) => void
  className?: string
}

export function CreationHistory({ generations, selectedId, pending, onSelect, onCancel, onCheckStatus, onRepair, onDownloadDocument, className }: CreationHistoryProps) {
  const ordered = [...generations].sort((a, b) => b.timestamp - a.timestamp)
  return (
    <section aria-label="创作历史" className={cn("flex min-h-0 flex-col", className)}>
      <h2 className="mb-2 text-sm font-medium text-gray-300">创作历史</h2>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {!ordered.length && <p className="rounded-md border border-dashed border-white/15 px-3 py-5 text-xs leading-relaxed text-gray-500">每次生成的图片和修改要求都会保存在这里。</p>}
        {ordered.map(generation => {
          const parent = generations.find(item => item.id === generation.parentVersionId)
          const parentLabel = parent?.version ? `基于 V${parent.version}` : undefined
          const complete = generation.status === "complete" && Boolean(generation.imageUrl)
          const selected = generation.id === selectedId
          const label = generation.runStatus === "unknown" ? "结果待确认" : generation.runStatus === "save_pending" ? "等待补记保存" : generation.status === "loading" ? "生成中" : generation.status === "error" ? "未完成" : `V${generation.version ?? 1}`
          return (
            <article key={generation.id} data-generation-id={generation.id} className={cn("overflow-hidden rounded-md border", selected ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.025]")}>
              {complete ? (
                <button type="button" aria-label={`选择 ${label}`} aria-pressed={selected} disabled={pending} onClick={() => onSelect(generation.id)} className="flex w-full items-center gap-3 p-3 text-left hover:bg-white/5 disabled:cursor-default disabled:opacity-60">
                  <Image src={generation.imageUrl!} alt={`${label} 生成结果`} unoptimized width={64} height={64} className="h-14 w-14 shrink-0 rounded object-cover" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium text-white">{label}{selected && <Check className="size-3.5" />}</span>
                    <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-gray-400">{parentLabel && <span>{parentLabel}</span>}{generation.modelLabel && <span>{generation.modelLabel}</span>}</span>
                  </span>
                </button>
              ) : (
                <div className="flex items-center justify-between gap-2 p-3">
                  <div className="flex items-center gap-2 text-xs text-gray-300">{generation.status === "loading" ? <Loader2 className="size-4 animate-spin" /> : <AlertCircle className="size-4 text-amber-300" />}<span>{label}{parentLabel ? ` · ${parentLabel}` : ""}</span></div>
                  {generation.status === "loading" && <button type="button" onClick={() => onCancel(generation.id)} className="rounded border border-white/20 px-2 py-1 text-xs text-gray-300 hover:bg-white/10">停止等待</button>}
                </div>
              )}
              {(generation.runStatus === "unknown" || generation.runStatus === "save_pending") && <div className="flex gap-2 px-3 pb-3">
                <button type="button" onClick={() => onCheckStatus?.(generation.id)} className="rounded border border-white/20 px-2 py-1 text-xs">查看状态</button>
                <button type="button" onClick={() => onRepair?.(generation.id)} className="rounded border border-white/20 px-2 py-1 text-xs">仅补记保存</button>
              </div>}
              <p className="px-3 pb-2 text-[11px] text-gray-500">{[generation.aspectRatio, generation.quality, generation.document ? `文档：${generation.document.name}` : undefined].filter(Boolean).join(" · ")}</p>
              {generation.document && onDownloadDocument && <button type="button" onClick={() => onDownloadDocument(generation.document!)} className="mx-3 mb-3 rounded border border-white/20 px-2 py-1 text-xs text-gray-300 hover:bg-white/10">下载文档：{generation.document.name}</button>}
              <p className="select-text whitespace-pre-wrap break-words px-3 pb-3 text-xs leading-relaxed text-gray-400">{generation.prompt}</p>
              {generation.annotationSnapshot && <div className="space-y-1 px-3 pb-3 text-xs leading-relaxed text-sky-100" aria-label={`${label} 的已提交批注`}>
                <p className="text-gray-400">{parentLabel || "基础版本"} · 已提交的区域批注</p>
                {generation.annotationSnapshot.marks.map(mark => <p key={mark.id} className="select-text whitespace-pre-wrap break-words">{mark.number}. {mark.instruction}</p>)}
                <AnnotationSnapshotPreview snapshot={generation.annotationSnapshot} />
              </div>}
              {generation.status === "error" && generation.error && <p className="px-3 pb-3 text-xs leading-relaxed text-amber-300">{generation.error}</p>}
            </article>
          )
        })}
      </div>
    </section>
  )
}
