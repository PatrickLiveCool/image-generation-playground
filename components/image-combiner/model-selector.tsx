"use client"

import { useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { ModelMapping } from "@/lib/api-provider-types"
import { resolveModelMapping } from "@/lib/model-mappings"

export function ModelSelector({ value, onChange, mappings, onOpenApiSettings }: {
  value: string; onChange: (id: string) => void; mappings: ModelMapping[]; onOpenApiSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selected = resolveModelMapping(mappings, value)
  const filtered = mappings.filter(mapping => mapping.name.toLowerCase().includes(query.toLowerCase()))
  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (next) setQuery("") }}>
      <PopoverTrigger asChild>
        <button aria-label="选择模型" className="flex items-center gap-1.5 h-7 md:h-10 px-2 md:px-3 bg-black/50 border border-gray-600 text-gray-300 hover:text-white max-w-[140px] md:max-w-[220px]">
          <span className="text-xs font-medium truncate">{selected?.name || "选择模型"}</span><ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 max-w-[calc(100vw-2rem)] bg-neutral-950 border-white/20 text-white p-3 space-y-3">
        {mappings.length > 6 && <input aria-label="搜索模型名称" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称" className="w-full bg-black border border-white/20 rounded px-2 py-2 text-xs select-text" />}
        <div className="max-h-64 overflow-y-auto space-y-1">
          {filtered.map(mapping => (
            <button key={mapping.id} onClick={() => { onChange(mapping.id); setOpen(false) }} aria-pressed={value === mapping.id} className="w-full flex items-center gap-2 text-left text-sm p-2 rounded hover:bg-white/10">
              <span className="break-words min-w-0 flex-1">{mapping.name}</span>{value === mapping.id && <Check className="size-3 shrink-0" />}
            </button>
          ))}
          {!mappings.length && <p className="text-xs text-gray-400 leading-relaxed">还没有模型映射。先在设置里添加显示名称，并选择对应模型。</p>}
          {!!mappings.length && !filtered.length && <p className="text-xs text-gray-400">没有匹配的名称。</p>}
        </div>
        <button className="text-xs text-gray-300 underline underline-offset-4" onClick={() => { setOpen(false); onOpenApiSettings() }}>管理模型映射</button>
      </PopoverContent>
    </Popover>
  )
}
