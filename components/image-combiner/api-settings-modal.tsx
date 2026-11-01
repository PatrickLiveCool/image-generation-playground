"use client"

import { useEffect, useRef, useState } from "react"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ModelMappingEditor } from "./model-mapping-editor"
import { normalizeModelMappings, validateModelMappings } from "@/lib/model-mappings"
import { ProviderConfigurationError, providerConfigurationErrorMessage, syncProviderModels } from "@/lib/provider-configuration-client"
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
  revision: number
  secretConfigured: boolean
  requiresReload?: boolean
  onRequireReload: () => void
  onReload?: () => Promise<void>
  onSave: (settings: ProviderSettings, models: ProviderModel[], mappings: ModelMapping[], modelsSynced: boolean) => Promise<void>
}

export function ApiSettingsModal({ open, onOpenChange, settings, models, mappings, modelsSynced, revision, secretConfigured, requiresReload = false, onRequireReload, onReload, onSave }: ApiSettingsModalProps) {
  const [draft, setDraft] = useState({ ...settings, apiKey: "" })
  const [draftModels, setDraftModels] = useState(models)
  const [draftMappings, setDraftMappings] = useState(() => mappings.map((mapping) => ({ ...mapping })))
  const [draftModelsSynced, setDraftModelsSynced] = useState(modelsSynced)
  const [showToken, setShowToken] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const pendingRequest = useRef<AbortController | null>(null)
  const requestVersion = useRef(0)
  const busy = useRef(false)
  const active = useRef(false)

  function cancelSync() {
    ++requestVersion.current
    pendingRequest.current?.abort()
    pendingRequest.current = null
  }

  useEffect(() => {
    active.current = true
    cancelSync()
    setDraft({ ...settings, apiKey: "" })
    setShowToken(false)
    setLoading(false)
    if (open) {
      setDraftModels(models)
      setDraftMappings(mappings.map((mapping) => ({ ...mapping })))
      setDraftModelsSynced(modelsSynced)
      setError(null)
      setStatus(modelsSynced ? `最近同步了 ${models.length} 个模型，可重新同步。` : null)
    }
    return () => {
      active.current = false
      cancelSync()
    }
  }, [open, settings, models, mappings, modelsSynced, revision])

  function changeOpen(next: boolean) {
    if (busy.current) return
    if (!next) {
      cancelSync()
      setDraft((current) => ({ ...current, apiKey: "" }))
      setShowToken(false)
    }
    onOpenChange(next)
  }

  function updateConnection(field: "baseUrl" | "apiKey" | "apiMode", value: string) {
    if (busy.current) return
    cancelSync()
    setDraft((current) => ({ ...current, [field]: value }))
    setDraftModels([])
    setDraftModelsSynced(false)
    setLoading(false)
    setError(null)
    setStatus(null)
  }

  function validateDraft(next: ProviderSettings) {
    const canReuseToken = secretConfigured && next.baseUrl === settings.baseUrl
    if (secretConfigured && !next.apiKey.trim() && !canReuseToken) return "更换 Base URL 后，请输入该地址对应的新 Token。"
    const validation = validateProviderSettings({ ...next, apiKey: next.apiKey || (canReuseToken ? "stored-token" : "") })
    if (validation === "请填写 API Token。" && secretConfigured && !canReuseToken) return "更换 Base URL 后，请输入该地址对应的新 Token。"
    return validation
  }

  async function readModels() {
    if (busy.current || requiresReload) return
    cancelSync()
    const nextSettings = normalizeProviderSettings(draft)
    const validationError = validateDraft(draft)
    if (validationError) {
      setError(validationError)
      return
    }
    const controller = new AbortController()
    const current = requestVersion.current
    pendingRequest.current = controller
    setLoading(true)
    setError(null)
    setStatus(null)
    try {
      const nextModels = await syncProviderModels({ revision, ...nextSettings }, controller.signal)
      if (controller.signal.aborted || current !== requestVersion.current || !active.current) return
      setDraftModels(nextModels)
      setDraftModelsSynced(true)
      setStatus(nextModels.length
        ? `已连接并读取 ${nextModels.length} 个模型。请选用支持图片生成的模型；生图能力将在生成时验证。`
        : "连接成功，未返回模型。已有映射保持不变，也可在下方手动填写模型 ID。")
    } catch (error) {
      if (!controller.signal.aborted && current === requestVersion.current && active.current) {
        if (error instanceof ProviderConfigurationError && error.code === "PROVIDER_REVISION_CONFLICT") {
          onRequireReload()
          setError("模型配置已被其他管理员修改，当前草稿已保留。请重新载入核对后再同步或保存。")
        } else setError(`${providerConfigurationErrorMessage(error)} 也可在下方映射中手动填写模型 ID。`)
      }
    } finally {
      if (pendingRequest.current === controller) {
        pendingRequest.current = null
        setLoading(false)
      }
    }
  }

  async function save() {
    if (busy.current || loading || requiresReload) return
    const nextSettings = normalizeProviderSettings(draft)
    const validationError = validateDraft(draft)
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
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      await onSave(nextSettings, draftModels, nextMappings, draftModelsSynced)
      if (active.current) {
        setDraft((current) => ({ ...current, apiKey: "" }))
        setShowToken(false)
        onOpenChange(false)
      }
    } catch (error) {
      if (active.current) setError(providerConfigurationErrorMessage(error))
    } finally {
      busy.current = false
      if (active.current) setSaving(false)
    }
  }

  async function reload() {
    if (busy.current || !onReload) return
    busy.current = true
    cancelSync()
    setLoading(false)
    setReloading(true)
    try {
      await onReload()
      if (active.current) setError(null)
    } catch (error) {
      if (active.current) setError(providerConfigurationErrorMessage(error))
    } finally {
      busy.current = false
      if (active.current) setReloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent showCloseButton={!saving && !reloading} onEscapeKeyDown={(event) => { if (busy.current) event.preventDefault() }} onPointerDownOutside={(event) => { if (busy.current) event.preventDefault() }} className="border-white/15 bg-[#101010] text-white sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">API 设置</DialogTitle>
          <DialogDescription className="text-gray-400">
            设置全局中转服务与名称映射，启用的登录用户共用保存后的配置。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void save() }} aria-busy={saving || reloading}>
        <fieldset className="min-w-0 space-y-5" disabled={saving || reloading}>
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
                placeholder={secretConfigured ? "已配置；留空保留原 Token" : "填写中转提供的 Token"}
                autoComplete="off"
                spellCheck={false}
                className="border-white/20 bg-black/40 pr-11"
                aria-describedby="provider-token-help"
              />
              <button
                type="button"
                disabled={!draft.apiKey}
                onClick={() => setShowToken((visible) => !visible)}
                aria-label={showToken ? "隐藏 Token" : "显示 Token"}
                className="absolute right-0 top-0 flex h-9 w-10 items-center justify-center rounded-md text-gray-400 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p id="provider-token-help" className="text-xs leading-relaxed text-gray-400">
              {secretConfigured ? "Token 已在服务端加密保管，不回显。地址不变时留空可保留；更换地址须输入新 Token。" : "Token 将由服务端加密保管，不写入浏览器存储。"}
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="provider-api-mode" className="text-sm font-medium">图片生成接口</label>
            <select
              id="provider-api-mode"
              value={draft.apiMode}
              onChange={(event) => updateConnection("apiMode", event.target.value as ProviderApiMode)}
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
                <p className="mt-1 text-xs text-gray-400">同步只读取当前草稿，点击保存才更新全局配置。</p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={requiresReload}
                onClick={readModels}
                className="border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? "重新同步" : "同步模型"}
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
          {requiresReload && <div className="space-y-2 text-sm leading-relaxed text-amber-300"><p>保存结果或配置版本尚未确认，请重新载入核对。读取成功前保留当前草稿；读取成功后将显示服务端配置。</p><Button type="button" variant="outline" onClick={() => void reload()}>重新载入核对</Button></div>}
          <div className="flex justify-end gap-2 border-t border-white/10 pt-4">
            <Button type="button" variant="ghost" onClick={() => changeOpen(false)} className="text-gray-300 hover:bg-white/10 hover:text-white">取消</Button>
            <Button type="submit" disabled={loading || requiresReload} className="bg-white text-black hover:bg-gray-200">{saving ? "正在保存…" : reloading ? "正在读取…" : "保存配置"}</Button>
          </div>
        </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  )
}
