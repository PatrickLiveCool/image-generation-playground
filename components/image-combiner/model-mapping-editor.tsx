"use client"

import { useId } from "react"
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ModelMapping, ProviderModel } from "@/lib/api-provider-types"

interface ModelMappingEditorProps {
  mappings: ModelMapping[]
  models: ProviderModel[]
  modelsSynced: boolean
  onChange: (mappings: ModelMapping[]) => void
}

export function ModelMappingEditor({ mappings, models, modelsSynced, onChange }: ModelMappingEditorProps) {
  const modelListId = useId()
  const modelIds = new Set(models.map((model) => model.id))

  function update(id: string, field: "name" | "modelId", value: string) {
    onChange(mappings.map((mapping) => mapping.id === id ? { ...mapping, [field]: value } : mapping))
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= mappings.length) return
    const next = [...mappings]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <section className="space-y-3" aria-labelledby="model-mappings-title">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id="model-mappings-title" className="text-sm font-medium">显示名称与模型映射</h3>
          <p className="mt-1 text-xs leading-relaxed text-gray-400">
            自定义“极致”“均衡”等名称，生成界面只显示这里设置的名称。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange([...mappings, { id: crypto.randomUUID(), name: "", modelId: "" }])}
          className="shrink-0 border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
        >
          <Plus className="h-4 w-4" />添加映射
        </Button>
      </div>
      <datalist id={modelListId}>
        {models.map((model) => <option key={model.id} value={model.id} />)}
      </datalist>
      {!mappings.length && (
        <div className="rounded-md border border-dashed border-white/20 p-4 text-sm leading-relaxed text-gray-400">
          还没有模型映射。点击“添加映射”，填写显示名称，再选择对应的实际模型。需要几个选项，就添加几条。
        </div>
      )}
      <div className="space-y-3">
        {mappings.map((mapping, index) => {
          const missing = modelsSynced && Boolean(mapping.modelId.trim()) && !modelIds.has(mapping.modelId.trim())
          const nameId = `mapping-${mapping.id}-name`
          const modelId = `mapping-${mapping.id}-model`
          const warningId = `mapping-${mapping.id}-warning`
          return (
            <div key={mapping.id} data-mapping-id={mapping.id} className="rounded-md border border-white/10 bg-white/[0.03] p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-gray-400">映射 {index + 1}</span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={`上移映射 ${index + 1}`}
                    className="h-7 w-7 text-gray-400 hover:bg-white/10 hover:text-white"
                  ><ArrowUp className="h-3.5 w-3.5" /></Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={index === mappings.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`下移映射 ${index + 1}`}
                    className="h-7 w-7 text-gray-400 hover:bg-white/10 hover:text-white"
                  ><ArrowDown className="h-3.5 w-3.5" /></Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onChange(mappings.filter((item) => item.id !== mapping.id))}
                    aria-label={`删除映射 ${index + 1}`}
                    className="h-7 w-7 text-gray-400 hover:bg-red-500/10 hover:text-red-300"
                  ><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div className="space-y-1.5">
                  <label htmlFor={nameId} className="text-xs text-gray-300">显示名称 {index + 1}</label>
                  <Input
                    id={nameId}
                    value={mapping.name}
                    onChange={(event) => update(mapping.id, "name", event.target.value)}
                    placeholder={index === 1 ? "例如：均衡" : "例如：极致"}
                    maxLength={40}
                    autoComplete="off"
                    className="border-white/20 bg-black/40"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={modelId} className="text-xs text-gray-300">实际模型 {index + 1}</label>
                  <Input
                    id={modelId}
                    list={modelListId}
                    value={mapping.modelId}
                    onChange={(event) => update(mapping.id, "modelId", event.target.value)}
                    placeholder="选择同步模型或手动输入模型 ID"
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                    className="border-white/20 bg-black/40"
                    aria-describedby={missing ? warningId : undefined}
                  />
                </div>
              </div>
              {missing && (
                <p id={warningId} role="status" className="text-xs leading-relaxed text-amber-300">
                  此模型未出现在最近同步的列表中。映射已保留，请确认中转仍支持该模型；也可以手动填写它的模型 ID。
                </p>
              )}
            </div>
          )
        })}
      </div>
      <p className="text-xs leading-relaxed text-gray-500">上下移动可调整生成界面的顺序。重新同步只更新可选模型，不会改写这些映射。</p>
    </section>
  )
}
