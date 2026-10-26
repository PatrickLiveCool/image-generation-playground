"use client"

import { useState, type FormEvent } from "react"
import { Plus, Pencil, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { Generation } from "./types"

export interface CreationListProps {
  creations: Array<{ id: string; title: string; unread: boolean; versions: Generation[] }>
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onRename: (id: string, title: string) => void
}

export function CreationList({ creations, activeId, onSelect, onCreate, onRename }: CreationListProps) {
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null)
  const [error, setError] = useState("")
  const active = creations.find(creation => creation.id === activeId)
  const startRename = (creation: { id: string; title: string }) => { setEditing(creation); setError("") }
  const saveName = (event: FormEvent) => {
    event.preventDefault()
    const title = editing?.title.trim() ?? ""
    if (!title) { setError("请填写创作名称。"); return }
    if (!editing) return
    try { onRename(editing.id, title); setEditing(null) }
    catch { setError("名称未能保存，请重试。") }
  }

  return (
    <nav aria-label="创作列表" className="flex min-h-0 flex-col gap-3 lg:h-full">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-300">我的创作</h2>
        <Button type="button" onClick={onCreate} size="sm" className="h-8 bg-white text-black hover:bg-gray-200">
          <Plus className="size-3.5" />新建创作
        </Button>
      </div>

      <div className="flex items-center gap-2 lg:hidden">
        <label htmlFor="active-creation" className="sr-only">切换创作</label>
        <select id="active-creation" value={activeId} onChange={event => onSelect(event.target.value)} className="min-w-0 flex-1 rounded-md border border-white/20 bg-neutral-950 px-3 py-2 text-sm text-white">
          {!creations.length && <option value="">暂无创作</option>}
          {creations.map(creation => <option key={creation.id} value={creation.id}>{creation.title}{creation.versions.some(version => version.status === "loading") ? " · 生成中" : creation.unread ? " · 新结果" : ""}</option>)}
        </select>
        <button type="button" disabled={!active} aria-label="重命名当前创作" onClick={() => active && startRename(active)} className="rounded-md border border-white/20 p-2 text-gray-300 hover:bg-white/10 disabled:opacity-40"><Pencil className="size-4" /></button>
      </div>

      <div className="hidden min-h-0 flex-1 flex-col gap-1 overflow-y-auto lg:flex">
        {creations.map(creation => {
          const pending = creation.versions.some(version => version.status === "loading")
          const count = creation.versions.filter(version => version.status === "complete").length
          return (
            <div key={creation.id} className={cn("group flex items-center rounded-md border transition-colors", activeId === creation.id ? "border-white/25 bg-white/10" : "border-transparent hover:bg-white/5")}>
              <button type="button" onClick={() => onSelect(creation.id)} aria-current={activeId === creation.id ? "page" : undefined} className="min-w-0 flex-1 px-3 py-2.5 text-left">
                <span className="block truncate text-sm text-white" title={creation.title}>{creation.title}</span>
                <span className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-400">
                  {pending ? <><Loader2 className="size-3 animate-spin" />生成中</> : creation.unread ? <><span className="size-1.5 rounded-full bg-emerald-300" />新结果</> : count ? `${count} 个版本` : "等待首次生成"}
                </span>
              </button>
              <button type="button" aria-label={`重命名 ${creation.title}`} onClick={() => startRename(creation)} className="mr-1 rounded p-2 text-gray-400 opacity-60 hover:bg-white/10 hover:text-white group-hover:opacity-100 focus-visible:opacity-100"><Pencil className="size-3.5" /></button>
            </div>
          )
        })}
      </div>

      <Dialog open={Boolean(editing)} onOpenChange={open => { if (!open) setEditing(null) }}>
        <DialogContent className="border-white/15 bg-neutral-950 text-white sm:max-w-sm">
          <DialogHeader><DialogTitle>重命名创作</DialogTitle><DialogDescription className="text-gray-400">名称仅用于区分创作，历史版本会保留。</DialogDescription></DialogHeader>
          <form onSubmit={saveName} className="space-y-4">
            <label htmlFor="creation-name" className="sr-only">创作名称</label>
            <Input id="creation-name" value={editing?.title ?? ""} onChange={event => setEditing(current => current && { ...current, title: event.target.value })} maxLength={60} className="border-white/20 bg-black/40" autoFocus />
            {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEditing(null)} className="hover:bg-white/10 hover:text-white">取消</Button><Button type="submit" className="bg-white text-black hover:bg-gray-200">保存名称</Button></div>
          </form>
        </DialogContent>
      </Dialog>
    </nav>
  )
}
