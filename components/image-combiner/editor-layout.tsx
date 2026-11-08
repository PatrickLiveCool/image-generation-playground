"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import type { ImperativePanelGroupHandle } from "react-resizable-panels"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"

const STORAGE_KEY = "image-playground.editor-layout.v1"
const DEFAULT_LEFT = 35
const INPUT_MIN_WIDTH = 360
const PREVIEW_MIN_WIDTH = 320
const HANDLE_WIDTH = 12

function readPreferredWidth() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100) return value
  } catch {}
  return DEFAULT_LEFT
}

/** Keep one editor tree mounted while its panels change between columns and rows. */
export function EditorLayout({ input, history, preview, actions }: { input: ReactNode; history: ReactNode; preview: ReactNode; actions: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<ImperativePanelGroupHandle>(null)
  const preferredWidth = useRef(DEFAULT_LEFT)
  const dragStartWidth = useRef<number | null>(null)
  const [size, setSize] = useState({ width: 0, wideViewport: false })
  const availableWidth = Math.max(0, size.width - HANDLE_WIDTH)
  // Panel styles round percentages; round minima up so a rounded panel never
  // slips below the usable pixel width at a particular container size.
  const leftLimit = Math.ceil(INPUT_MIN_WIDTH / Math.max(1, availableWidth) * 1000) / 10
  const rightLimit = Math.ceil(PREVIEW_MIN_WIDTH / Math.max(1, availableWidth) * 1000) / 10
  const desktop = size.wideViewport && leftLimit + rightLimit <= 100
  const minimumLeft = desktop ? leftLimit : 0
  const minimumRight = desktop ? rightLimit : 0

  useEffect(() => {
    preferredWidth.current = readPreferredWidth()
    const container = containerRef.current
    if (!container) return
    const media = window.matchMedia("(min-width: 1024px)")
    const measure = () => setSize({ width: container.getBoundingClientRect().width, wideViewport: media.matches })
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    media.addEventListener("change", measure)
    measure()
    return () => { observer.disconnect(); media.removeEventListener("change", measure) }
  }, [])

  useEffect(() => {
    if (!desktop) return
    const left = Math.min(100 - minimumRight, Math.max(minimumLeft, preferredWidth.current))
    groupRef.current?.setLayout([left, 100 - left])
  }, [desktop, minimumLeft, minimumRight])

  // Constraint changes can also emit onLayout; only explicit resizes are saved.
  const saveLayout = useCallback(() => {
    const layout = groupRef.current?.getLayout()
    if (!desktop || !layout || layout.length !== 2 || !Number.isFinite(layout[0])) return
    preferredWidth.current = layout[0]
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout[0])) } catch {}
  }, [desktop])
  const reset = () => {
    preferredWidth.current = DEFAULT_LEFT
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_LEFT)) } catch {}
    const left = Math.min(100 - minimumRight, Math.max(minimumLeft, DEFAULT_LEFT))
    groupRef.current?.setLayout([left, 100 - left])
  }

  return (
    <div ref={containerRef} data-editor-layout={desktop ? "columns" : "rows"} className={desktop ? "min-h-0 min-w-0 flex-1" : "min-w-0 shrink-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pb-44"}>
      <ResizablePanelGroup ref={groupRef} direction="horizontal" keyboardResizeBy={5} style={desktop ? undefined : { display: "flex", flexDirection: "column", height: "auto", overflow: "visible", gap: 12 }}>
        <ResizablePanel id="creation-input" order={1} defaultSize={Math.max(minimumLeft, Math.min(100 - minimumRight, DEFAULT_LEFT))} minSize={minimumLeft} style={desktop ? undefined : { display: "contents" }}>
          <div className={desktop ? "flex h-full min-h-0 flex-col gap-3 pr-2" : "contents"}>
            <div className={desktop ? "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" : "contents"}>
              <div className="min-w-0">{input}</div>
              <div className={desktop ? "min-w-0 shrink-0" : "order-3 min-w-0"}>{history}</div>
            </div>
            <div className={desktop ? "shrink-0" : "fixed inset-x-0 bottom-0 z-30"}>{actions}</div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle disabled={!desktop} tabIndex={desktop ? 0 : -1} aria-orientation="vertical" aria-label="调整工作区与图片宽度" title="拖动或用方向键调整；双击或按 Enter 恢复默认比例" className="w-3 shrink-0 bg-transparent after:w-3 [&>div]:h-8 [&>div]:border-white/20 [&>div]:bg-neutral-800" style={desktop ? undefined : { display: "none" }} onDoubleClick={reset}
          onDragging={dragging => {
            if (dragging) dragStartWidth.current = groupRef.current?.getLayout()[0] ?? null
            else {
              if (dragStartWidth.current !== null && dragStartWidth.current !== groupRef.current?.getLayout()[0]) saveLayout()
              dragStartWidth.current = null
            }
          }}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); reset() }
            else if (event.defaultPrevented && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) saveLayout()
          }} />
        <ResizablePanel id="creation-preview" order={2} defaultSize={100 - Math.max(minimumLeft, Math.min(100 - minimumRight, DEFAULT_LEFT))} minSize={minimumRight} style={desktop ? undefined : { flexBasis: "auto", flexGrow: 0, flexShrink: 0, order: 2, overflow: "visible" }}>
          <div className={desktop ? "h-full min-h-0 min-w-0 pl-2" : "h-[420px] min-w-0"}>{preview}</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
