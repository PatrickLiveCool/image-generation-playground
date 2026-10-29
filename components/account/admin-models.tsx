"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCw, Settings2 } from "lucide-react"
import { AccountGate } from "@/components/account/account-gate"
import { AccountLoading } from "@/components/account/account-shell"
import { ApiSettingsModal } from "@/components/image-combiner/api-settings-modal"
import { Button } from "@/components/ui/button"
import {
  ProviderConfigurationError,
  providerConfigurationErrorMessage,
  readAdminProviderConfiguration,
  saveAdminProviderConfiguration,
} from "@/lib/provider-configuration-client"
import type { ModelMapping, ProviderModel, ProviderSettings } from "@/lib/api-provider-types"
import type { AdminProviderConfiguration } from "@/lib/provider-configuration-types"

export function AdminModelsManager() {
  const [configuration, setConfiguration] = useState<AdminProviderConfiguration | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [notice, setNotice] = useState("")
  const [open, setOpen] = useState(false)
  const [requiresReload, setRequiresReload] = useState(false)
  const active = useRef(false)
  const pendingRead = useRef<AbortController | null>(null)
  const version = useRef(0)
  const saving = useRef(false)
  const mustReload = useRef(false)

  const load = useCallback(async () => {
    if (saving.current) return
    pendingRead.current?.abort()
    const controller = new AbortController()
    const current = ++version.current
    pendingRead.current = controller
    setLoading(true)
    setLoadError("")
    try {
      const next = await readAdminProviderConfiguration(controller.signal)
      if (current !== version.current || !active.current) return
      setConfiguration(next)
      mustReload.current = false
      setRequiresReload(false)
    } catch (error) {
      if (controller.signal.aborted || current !== version.current || !active.current) return
      setLoadError(providerConfigurationErrorMessage(error))
      throw error
    } finally {
      if (current === version.current && active.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    active.current = true
    void load().catch(() => {})
    return () => { active.current = false; ++version.current; pendingRead.current?.abort() }
  }, [load])

  function requireReload() {
    mustReload.current = true
    setRequiresReload(true)
  }

  async function save(settings: ProviderSettings, models: ProviderModel[], mappings: ModelMapping[], modelsSynced: boolean) {
    if (!configuration || saving.current || mustReload.current) throw new ProviderConfigurationError("请先重新载入核对服务端配置。", 409, "RELOAD_REQUIRED")
    saving.current = true
    setNotice("")
    try {
      const next = await saveAdminProviderConfiguration({ revision: configuration.revision, settings, models, mappings, modelsSynced })
      if (!active.current) return
      setConfiguration(next)
      setNotice("配置已保存，启用的登录用户将使用这份名称映射。")
      setLoadError("")
    } catch (error) {
      if (active.current && (!(error instanceof ProviderConfigurationError) || error.status === 0 || error.status >= 500 || error.status === 409)) {
        requireReload()
      }
      throw error
    } finally {
      saving.current = false
    }
  }

  return <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2"><a href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">返回创作</a><h1 className="text-2xl font-semibold">模型设置</h1><p className="text-sm text-muted-foreground">沿用 API 设置和名称映射，保存后供启用的登录用户共用。</p></div>
      <Button variant="outline" disabled={loading || open} onClick={() => void load().catch(() => {})}><RefreshCw className="size-4" aria-hidden="true" />刷新</Button>
    </header>
    <nav aria-label="后台导航" className="flex gap-4 border-b border-border pb-3 text-sm"><a href="/admin/users" className="text-muted-foreground hover:underline">账号管理</a><a href="/admin/models" aria-current="page" className="font-medium">模型设置</a></nav>
    {notice && <p role="status" className="border border-border p-4 text-sm">{notice}</p>}
    {loadError && <p role="alert" className="border border-red-400/50 p-4 text-sm text-red-400">{loadError}</p>}
    {loading && !configuration ? <AccountLoading message="正在读取模型配置…" /> : configuration ? <section className="space-y-5 border border-border p-5">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><h2 className="font-medium">API 配置</h2><p className="break-all text-sm text-muted-foreground">{configuration.settings.baseUrl || "尚未配置 API 地址"}</p><p className="text-sm text-muted-foreground">{configuration.secretConfigured ? "Token 已配置，由服务端加密保管" : "尚未配置 Token"} · {configuration.settings.apiMode === "images" ? "Images" : "Chat Completions"}</p></div><Button disabled={loading} onClick={() => setOpen(true)}><Settings2 className="size-4" aria-hidden="true" />API 设置</Button></div>
      <div className="space-y-2"><h3 className="text-sm font-medium">显示名称</h3>{configuration.mappings.length ? <ol className="flex flex-wrap gap-2">{configuration.mappings.map((mapping) => <li key={mapping.id} className="border border-border px-3 py-1 text-sm">{mapping.name}</li>)}</ol> : <p className="text-sm text-muted-foreground">还没有名称映射，请在 API 设置中添加。</p>}</div>
      {requiresReload && <p role="alert" className="text-sm text-amber-400">上次保存结果或配置版本尚未确认，请刷新核对后再保存。</p>}
    </section> : <Button variant="outline" onClick={() => void load().catch(() => {})}>重新加载</Button>}
    {configuration && <ApiSettingsModal open={open} onOpenChange={setOpen} {...configuration} requiresReload={requiresReload} onRequireReload={requireReload} onReload={load} onSave={save} />}
  </main>
}

export function AdminModels() {
  return <AccountGate admin>{(user) => <AdminModelsManager key={user.id} />}</AccountGate>
}
