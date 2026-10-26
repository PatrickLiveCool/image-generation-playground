"use client"

import { useEffect, useRef, useState } from "react"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ModelMappingEditor } from "./model-mapping-editor"
import { normalizeModelMappings, validateModelMappings } from "@/lib/model-mappings"
import {
  normalizeProviderSettings,
  validateProviderSettings,
  type ModelMapping,
  type ProviderApiMode,
  type ProviderModel,
  type ProviderSettings,
} from "@/lib/api-provider-types"

interface ApiSettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: ProviderSettings
  models: ProviderModel[]
  mappings: ModelMapping[]
  modelsSynced: boolean
  onSave: (settings: ProviderSettings, models: ProviderModel[], mappings: ModelMapping[], modelsSynced: boolean) => void
}

export function ApiSettingsModal({ open, onOpenChange, settings, models, mappings, modelsSynced, onSave }: ApiSettingsModalProps) {
  const [draft, setDraft] = useState(settings)
  const [draftModels, setDraftModels] = useState(models)
  const [draftMappings, setDraftMappings] = useState(() => mappings.map((mapping) => ({ ...mapping })))
  const [draftModelsSynced, setDraftModelsSynced] = useState(modelsSynced)
  const [showToken, setShowToken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const pendingRequest = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setDraft(settings)
      setDraftModels(models)
      setDraftMappings(mappings.map((mapping) => ({ ...mapping })))
      setDraftModelsSynced(modelsSynced)
      setShowToken(false)
      setError(null)
      setStatus(modelsSynced ? `最近同步了 ${models.length} 个模型，可重新同步。` : null)
      setLoading(false)
    }
    return () => {
      pendingRequest.current?.abort()
      pendingRequest.current = null
    }
  }, [open, settings, models, mappings, modelsSynced])

  function updateConnection(field: "baseUrl" | "apiKey", value: string) {
    pendingRequest.current?.abort()
    pendingRequest.current = null
    setDraft((current) => ({ ...current, [field]: value }))
    setDraftModels([])
    setDraftModelsSynced(false)
    setLoading(false)
    setError(null)
    setStatus(null)
  }

  async function readModels() {
    const nextSettings = normalizeProviderSettings(draft)
    const validationError = validateProviderSettings(nextSettings)
    if (validationError) {
      setError(validationError)
      return
    }
    const controller = new AbortController()
    pendingRequest.current?.abort()
    pendingRequest.current = controller
    setLoading(true)
    setError(null)
    setStatus(null)
    try {
      const response = await fetch("/api/provider/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: nextSettings.baseUrl, apiKey: nextSettings.apiKey }),
        signal: controller.signal,
      })
      const result = await response.json()
      if (controller.signal.aborted) return
      if (!response.ok) {
        setError(typeof result.error === "string" ? result.error : "无法读取模型，请检查地址和 Token。")
        return
      }
      if (!Array.isArray(result.models)) {
        setError("中转返回的模型列表格式无法识别；你仍可在下方映射中手动填写模型 ID。")
        return
      }
      const ids = result.models
        .filter((model: unknown): model is ProviderModel => Boolean(
          model && typeof model === "object" && "id" in model && typeof model.id === "string" && model.id.trim(),
        ))
        .map((model: ProviderModel) => model.id)
      const nextModels: ProviderModel[] = [...new Set<string>(ids)].map((id) => ({ id }))
      setDraftModels(nextModels)
      setDraftModelsSynced(true)
      setStatus(nextModels.length
        ? `已连接并读取 ${nextModels.length} 个模型。请选用支持图片生成的模型；生图能力将在生成时验证。`
        : "连接成功，未返回模型。已有映射保持不变，也可在下方手动填写模型 ID。")
    } catch {
      if (!controller.signal.aborted) setError("读取模型失败，请稍后重试；也可在下方映射中手动填写模型 ID。")
    } finally {
      if (pendingRequest.current === controller) {
        pendingRequest.current = null
        setLoading(false)
      }
    }
  }

  function save() {
    const nextSettings = normalizeProviderSettings(draft)
    const validationError = validateProviderSettings(nextSettings)
    if (validationError) {
      setError(validationError)
      return
    }
    const nextMappings = normalizeModelMappings(draftMappings)
    const mappingError = validateModelMappings(nextMappings)
    if (mappingError) {
      setError(mappingError)
      return
    }
    onSave(nextSettings, draftModels, nextMappings, draftModelsSynced)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/15 bg-[#101010] text-white sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">API 设置</DialogTitle>
          <DialogDescription className="text-gray-400">
            接入自己的中转服务，模型与生成请求均使用这里的配置。
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); save() }}>
          <div className="space-y-2">
            <label htmlFor="provider-base-url" className="text-sm font-medium">Base URL</label>
            <Input
              id="provider-base-url"
              type="url"
              value={draft.baseUrl}
              onChange={(event) => updateConnection("baseUrl", event.target.value)}
              placeholder="https://relay.example/v1"
              autoComplete="off"
              spellCheck={false}
              className="border-white/20 bg-black/40"
              aria-describedby="provider-url-help"
            />
            <p id="provider-url-help" className="text-xs leading-relaxed text-gray-400">
              填写中转提供的完整 API 前缀（如包含 /v1，请一并填写）。应用会在此地址后拼接所选接口，不会自动添加 /v1。
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="provider-token" className="text-sm font-medium">API Token</label>
            <div className="relative">
              <Input
                id="provider-token"
                type={showToken ? "text" : "password"}
                value={draft.apiKey}
                onChange={(event) => updateConnection("apiKey", event.target.value)}
                placeholder="填写中转提供的 Token"
                autoComplete="off"
                spellCheck={false}
                className="border-white/20 bg-black/40 pr-11"
                aria-describedby="provider-token-help"
              />
              <button
                type="button"
                onClick={() => setShowToken((visible) => !visible)}
                aria-label={showToken ? "隐藏 Token" : "显示 Token"}
                className="absolute right-0 top-0 flex h-9 w-10 items-center justify-center rounded-md text-gray-400 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p id="provider-token-help" className="text-xs leading-relaxed text-gray-400">
              配置仅保存在当前标签页的会话中，刷新后仍可使用。关闭后重新打开时可能需要再次填写。
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="provider-api-mode" className="text-sm font-medium">图片生成接口</label>
            <select
              id="provider-api-mode"
              value={draft.apiMode}
              onChange={(event) => setDraft((current) => ({ ...current, apiMode: event.target.value as ProviderApiMode }))}
              className="h-10 w-full rounded-md border border-white/20 bg-[#171717] px-3 text-sm text-white focus-visible:outline-2 focus-visible:outline-white"
              aria-describedby="provider-mode-help"
            >
              <option value="images">Images（图片生成 / 编辑）</option>
              <option value="chat">Chat Completions（对话兼容生图）</option>
            </select>
            <p id="provider-mode-help" className="text-xs leading-relaxed text-gray-400">
              按中转对该模型的说明选择。模型列表可读取，不代表每个模型都支持生成图片。
            </p>
          </div>
          <div className="space-y-3 rounded-md border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm">模型列表</p>
                <p className="mt-1 text-xs text-gray-400">同步后，在下方设置显示名称与模型的对应关系。</p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={readModels}
                className="border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? "正在同步" : "同步模型"}
              </Button>
            </div>
            {status && <p role="status" className="text-xs leading-relaxed text-emerald-300">{status}</p>}
          </div>
          <ModelMappingEditor
            mappings={draftMappings}
            models={draftModels}
            modelsSynced={draftModelsSynced}
            onChange={(nextMappings) => { setDraftMappings(nextMappings); setError(null) }}
          />
          {error && <p role="alert" className="text-sm leading-relaxed text-red-300">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-white/10 pt-4">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} className="text-gray-300 hover:bg-white/10 hover:text-white">取消</Button>
            <Button type="submit" disabled={loading} className="bg-white text-black hover:bg-gray-200">保存配置</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
