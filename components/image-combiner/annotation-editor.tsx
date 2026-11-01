"use client"

import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent } from "react"
import { annotationDisplayBounds, orientedImageSize, toDisplayPoint, type AnnotationDraft, type AnnotationMark, type AnnotationPoint, type AnnotationSnapshot } from "@/lib/image-annotations"
import { containImageRect, drawnAnnotation, nudgeAnnotation, replaceAnnotationMarks } from "@/lib/annotation-draft"

type MarkType = AnnotationMark["geometry"]["type"]
export interface AnnotationEditorController {
  draft?: AnnotationDraft
  selectedId: string | null
  select: (id: string | null) => void
  change: (marks: AnnotationMark[], nextNumber?: number) => void
  instruction: (id: string, value: string) => void
  remove: (id: string) => void
  undo: () => void
  canUndo: boolean
  message: string
  report: (message: string) => void
}

export function useAnnotationEditor(draft: AnnotationDraft | undefined, save: (value: AnnotationDraft) => void, identity: string): AnnotationEditorController {
  const [selectedId, select] = useState<string | null>(null)
  const [message, report] = useState("")
  const [undoStack, setUndoStack] = useState<AnnotationMark[][]>([])
  useEffect(() => { select(null); setUndoStack([]); report("") }, [identity])
  const change = (marks: AnnotationMark[], nextNumber?: number) => {
    if (!draft) return
    try {
      const next = replaceAnnotationMarks(draft, marks, nextNumber)
      setUndoStack(stack => [...stack.slice(-39), draft.snapshot.marks])
      save(next); report("批注已保存在当前基础版本的草稿中。")
    } catch (error) { report(error instanceof Error ? error.message : "批注无效，已保留原草稿。") }
  }
  return { draft, selectedId, select, change, report, message, canUndo: undoStack.length > 0,
    instruction: (id, value) => change(draft?.snapshot.marks.map(mark => mark.id === id ? { ...mark, instruction: value } : mark) ?? []),
    remove: id => { change(draft?.snapshot.marks.filter(mark => mark.id !== id) ?? []); select(null) },
    undo: () => {
      const previous = undoStack.at(-1)
      if (!draft || !previous) return
      try { save(replaceAnnotationMarks(draft, previous)); setUndoStack(stack => stack.slice(0, -1)); report("已撤销上一步批注编辑，编号不重排。") }
      catch (error) { report(error instanceof Error ? error.message : "撤销失败。") }
    },
  }
}

const buttonClass = "rounded border border-white/25 px-2 py-1 text-xs text-gray-200 hover:bg-white/10 disabled:opacity-40"
export function AnnotationList({ editor, reason, onSubmit }: { editor: AnnotationEditorController; reason?: string; onSubmit: () => void }) {
  const marks = editor.draft?.snapshot.marks ?? []
  if (!marks.length) return null
  return <section aria-label="区域批注" className="min-w-0 space-y-2 rounded-md border border-sky-300/30 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-sky-100">区域批注 · {marks.length}/20</p><button type="button" onClick={editor.undo} disabled={!editor.canUndo} className={buttonClass}>撤销批注</button></div>
    <p className="text-xs text-gray-400">与图上浮框同步；整体修改要求可留空。</p>
    {marks.map(mark => <div key={mark.id} className="space-y-1.5">
      <div className="flex items-center justify-between gap-2"><button type="button" className={buttonClass} aria-pressed={editor.selectedId === mark.id} onClick={() => editor.select(mark.id)}>定位批注 {mark.number}</button><button type="button" className={buttonClass} onClick={() => editor.remove(mark.id)} aria-label={`删除批注 ${mark.number}`}>删除</button></div>
      <textarea aria-label={`批注 ${mark.number} 的说明`} value={mark.instruction} onChange={event => editor.instruction(mark.id, event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey || event.shiftKey) && event.key === "Enter") { event.preventDefault(); onSubmit() } }} className="min-h-16 w-full resize-y rounded border border-white/25 bg-black p-2 text-sm text-white" placeholder="说明这一区域要如何修改（最多 500 字）" />
    </div>)}
    {reason && <p role="alert" className="text-xs leading-relaxed text-amber-200">{reason}</p>}
  </section>
}

function MarkShape({ mark, image, selected }: { mark: AnnotationMark; image: AnnotationSnapshot["image"]; selected: boolean }) {
  const geometry = mark.geometry
  const style = { stroke: selected ? "#fbbf24" : "#38bdf8", fill: "rgba(56,189,248,.10)", strokeWidth: 2, vectorEffect: "non-scaling-stroke" as const }
  if (geometry.type === "rectangle") {
    const bounds = annotationDisplayBounds(mark, image)
    return <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} {...style} />
  }
  const points = geometry.points.map(point => toDisplayPoint(point, image))
  if (geometry.type === "lasso") return <polygon points={points.map(point => `${point.x},${point.y}`).join(" ")} fillRule="evenodd" {...style} />
  return <g><polyline points={points.map(point => `${point.x},${point.y}`).join(" ")} fill="none" stroke={style.stroke} strokeOpacity=".35" strokeWidth={geometry.brushWidth} strokeLinecap="round" strokeLinejoin="round" />{points.length === 1 && <circle cx={points[0].x} cy={points[0].y} r={geometry.brushWidth / 2} fill={style.stroke} fillOpacity=".35" />}</g>
}

/** Historical geometry comes exclusively from the accepted server snapshot. */
export function AnnotationSnapshotPreview({ snapshot }: { snapshot: AnnotationSnapshot }) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const size = orientedImageSize(snapshot.image)
  return <div className="mt-2">
    <button type="button" className={buttonClass} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起原图批注" : "查看原图批注"}</button>
    {open && <div className="relative mt-2 w-full overflow-hidden rounded border border-white/15" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
      <img src={`/api/images/${snapshot.image.assetId}`} alt="已提交批注的原始基准图" className="absolute inset-0 h-full w-full object-contain" onError={() => setFailed(true)} />
      {!failed && <svg aria-label="已提交的区域快照" className="absolute inset-0 h-full w-full" viewBox={`0 0 ${size.width} ${size.height}`}>
        {snapshot.marks.map(mark => { const bounds = annotationDisplayBounds(mark, snapshot.image), textSize = size.width / 18; return <g key={mark.id}><MarkShape mark={mark} image={snapshot.image} selected={false} /><rect x={bounds.x} y={bounds.y} width={textSize * 1.6} height={textSize * 1.3} fill="#0369a1" /><text x={bounds.x + textSize * .8} y={bounds.y + textSize} textAnchor="middle" fill="white" fontSize={textSize}>{mark.number}</text></g> })}
      </svg>}
      {failed && <p role="status" className="absolute inset-0 flex items-center justify-center bg-black/90 p-3 text-xs text-gray-300">原图暂不可读，已提交的说明仍保留。</p>}
    </div>}
  </div>
}

export function AnnotationTools({ editor, disabledReason, tool, setTool, addCenter, onRetryMetadata }: { editor: AnnotationEditorController; disabledReason?: string; tool: MarkType | null; setTool: (value: MarkType | null) => void; addCenter: () => void; onRetryMetadata?: () => void }) {
  return <div className="space-y-1">
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="绘制批注工具">
      {(["rectangle", "lasso", "brush"] as const).map(type => <button type="button" key={type} disabled={Boolean(disabledReason)} aria-pressed={tool === type} onClick={() => setTool(tool === type ? null : type)} className={buttonClass}>{({ rectangle: "矩形", lasso: "自由圈选", brush: "涂抹" })[type]}</button>)}
      <button type="button" disabled={Boolean(disabledReason)} onClick={addCenter} className={buttonClass}>添加中心区域</button>
      <button type="button" onClick={editor.undo} disabled={!editor.canUndo} className={buttonClass}>撤销</button>
      {onRetryMetadata && <button type="button" onClick={onRetryMetadata} className={buttonClass}>重新读取图片信息</button>}
      {tool && <button type="button" onClick={() => setTool(null)} className={buttonClass}>结束绘制</button>}
    </div>
    <p role="status" aria-live="polite" className="text-[11px] leading-relaxed text-gray-400">{disabledReason || editor.message || "选择工具后在图上标记。选中区域后方向键移动，Shift + 方向键调整，Enter 编辑说明，Delete 删除。"}</p>
  </div>
}

export function addCenterAnnotation(editor: AnnotationEditorController) {
  if (!editor.draft) return
  const image = editor.draft.snapshot.image, display = orientedImageSize(image)
  const id = crypto.randomUUID()
  const mark: AnnotationMark = { id, number: editor.draft.nextNumber, instruction: "", geometry: drawnAnnotation("rectangle", [{ x: display.width * .35, y: display.height * .35 }, { x: display.width * .65, y: display.height * .65 }], image, 1) }
  editor.change([...editor.draft.snapshot.marks, mark], mark.number + 1); editor.select(id)
}

export function AnnotationCanvas({ editor, tool, disabled, onSubmit }: { editor: AnnotationEditorController; tool: MarkType | null; disabled: boolean; onSubmit: () => void }) {
  const container = useRef<HTMLDivElement>(null)
  const floatingInput = useRef<HTMLTextAreaElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const gesture = useRef<{ pointerId: number; type: MarkType; points: AnnotationPoint[] } | null>(null)
  const [preview, setPreview] = useState<AnnotationMark | null>(null)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const update = () => { const rect = element.getBoundingClientRect(); setSize({ width: rect.width, height: rect.height }) }
    update(); const observer = new ResizeObserver(update); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { gesture.current = null; setPreview(null) }, [disabled, editor.draft?.snapshot.baseVersionId])
  useEffect(() => {
    if (!editor.selectedId) return
    const mark = container.current?.querySelector<SVGElement>(`[data-annotation-id="${editor.selectedId}"]`)
    // This makes center insertion and “定位批注” immediately keyboard-operable.
    ;(mark as unknown as HTMLElement | null)?.focus?.()
  }, [editor.selectedId])
  if (!editor.draft) return null
  const { snapshot } = editor.draft
  const image = snapshot.image, display = orientedImageSize(image), box = containImageRect(size, display)
  const selected = snapshot.marks.find(mark => mark.id === editor.selectedId)
  const bounds = selected ? annotationDisplayBounds(selected, image) : null
  const point = (event: PointerEvent<SVGSVGElement>): AnnotationPoint | null => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return { x: Math.max(0, Math.min(display.width, (event.clientX - rect.left) * display.width / rect.width)), y: Math.max(0, Math.min(display.height, (event.clientY - rect.top) * display.height / rect.height)) }
  }
  const finish = (event: PointerEvent<SVGSVGElement>) => {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return
    gesture.current = null; setPreview(null)
    if (disabled) return
    const last = point(event)
    if (last && (last.x !== active.points.at(-1)?.x || last.y !== active.points.at(-1)?.y)) active.points.push(last)
    const id = crypto.randomUUID()
    try {
      const mark: AnnotationMark = { id, number: editor.draft!.nextNumber, instruction: "", geometry: drawnAnnotation(active.type, active.points, image, Math.max(1, Math.min(display.width, display.height) * .035)) }
      editor.change([...snapshot.marks, mark], mark.number + 1); editor.select(id)
    } catch (error) { editor.report(error instanceof Error ? error.message : "请重新绘制有效区域。") }
  }
  const keyDown = (event: KeyboardEvent<SVGGElement>, mark: AnnotationMark) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.stopPropagation(); editor.undo(); return }
    if (event.key === "Enter") { event.preventDefault(); floatingInput.current?.focus(); return }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); event.stopPropagation(); editor.remove(mark.id); return }
    if (disabled || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const step = Math.max(1, Math.round(Math.min(display.width, display.height) / 100))
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0
    editor.change(snapshot.marks.map(item => item.id === mark.id ? nudgeAnnotation(mark, image, dx, dy, event.shiftKey) : item))
  }
  return <div ref={container} className="pointer-events-none absolute inset-0" data-annotation-canvas="true">
    {box.width > 0 && <svg aria-label="图片区域批注画布" viewBox={`0 0 ${display.width} ${display.height}`} className={tool && !disabled ? "pointer-events-auto absolute touch-none" : "pointer-events-none absolute"} style={{ left: box.left, top: box.top, width: box.width, height: box.height, cursor: tool ? "crosshair" : undefined }}
      onPointerDown={event => { if (disabled || !tool || event.button !== 0) return; const start = point(event); if (!start) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { pointerId: event.pointerId, type: tool, points: [start] }; editor.select(null) }}
      onPointerMove={event => { const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return; const next = point(event); if (!next) return; if (active.type === "rectangle") active.points = [active.points[0], next]; else { const last = active.points.at(-1)!; if (Math.hypot(next.x - last.x, next.y - last.y) < 1) return; active.points.push(next) }; if (active.points.length > 256) { gesture.current = null; setPreview(null); editor.report("单条路径最多 256 个点，请缩短本次绘制；原草稿已保留。"); return }; setPreview({ id: "preview", number: editor.draft!.nextNumber, instruction: "", geometry: drawnAnnotation(active.type, active.points, image, Math.max(1, Math.min(display.width, display.height) * .035)) }) }}
      onPointerUp={finish} onPointerCancel={() => { gesture.current = null; setPreview(null) }}>
      {[...snapshot.marks, ...(preview ? [preview] : [])].map(mark => { const label = annotationDisplayBounds(mark, image); return <g key={mark.id} data-annotation-id={mark.id} role="button" tabIndex={mark.id === "preview" ? -1 : 0} aria-label={`选择批注 ${mark.number}`} aria-pressed={editor.selectedId === mark.id} className="pointer-events-auto outline-none" onFocus={() => editor.select(mark.id)} onClick={event => { event.stopPropagation(); if (!tool || disabled) editor.select(mark.id) }} onKeyDown={event => keyDown(event, mark)}><MarkShape mark={mark} image={image} selected={editor.selectedId === mark.id} /><g transform={`translate(${label.x} ${label.y}) scale(${1 / (box.scale || 1)})`}><rect width="25" height="23" rx="4" fill="#0369a1" /><text x="12.5" y="16" fill="white" fontSize="14" textAnchor="middle">{mark.number}</text></g></g> })}
    </svg>}
    {selected && bounds && box.width > 0 && <div className="pointer-events-auto absolute z-20 w-64 max-w-[calc(100%-16px)] rounded-md border border-sky-300/50 bg-black/95 p-2 shadow-xl" style={{ left: Math.max(8, Math.min(size.width - Math.min(256, size.width - 16) - 8, box.left + bounds.x * box.scale)), top: Math.max(8, box.top + bounds.y * box.scale - 112), width: Math.min(256, size.width - 16) }}>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-sky-100"><span>批注 {selected.number}</span><button type="button" onClick={() => editor.select(null)} aria-label="关闭批注浮框" className="px-2">×</button></div>
      <textarea ref={floatingInput} aria-label={`图上批注 ${selected.number} 的说明`} value={selected.instruction} onChange={event => editor.instruction(selected.id, event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey || event.shiftKey) && event.key === "Enter") { event.preventDefault(); onSubmit() } }} className="h-14 w-full resize-none rounded border border-white/25 bg-black p-1 text-sm text-white" placeholder="描述此区域的修改" />
      <button type="button" onClick={() => editor.remove(selected.id)} className="text-xs text-gray-400">删除此批注</button>
    </div>}
  </div>
}
