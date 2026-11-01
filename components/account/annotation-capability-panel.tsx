"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { providerConfigurationErrorMessage } from "@/lib/provider-configuration-client"
import { validateRecordAnnotationCapabilityInput, type DisableAnnotationCapabilityInput, type RecordAnnotationCapabilityInput } from "@/lib/annotation-capability"
import type { AdminProviderConfiguration } from "@/lib/provider-configuration-types"

export function AnnotationCapabilityPanel({ configuration, disabled, onRecord, onDisable }: {
  configuration: AdminProviderConfiguration
  disabled: boolean
  onRecord: (input: RecordAnnotationCapabilityInput) => Promise<void>
  onDisable: (input: DisableAnnotationCapabilityInput) => Promise<void>
}) {
  const [mappingId, setMappingId] = useState(configuration.mappings[0]?.id ?? "")
  const [reference, setReference] = useState("")
  const [note, setNote] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState<"record" | "disable" | null>(null)
  const [error, setError] = useState("")
  const busy = useRef(false)
  const active = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    if (!configuration.mappings.some(mapping => mapping.id === mappingId)) setMappingId(configuration.mappings[0]?.id ?? "")
    setConfirmed(false)
  }, [configuration, mappingId])
  const mapping = configuration.mappings.find(item => item.id === mappingId)
  const record = configuration.annotationCapabilities.find(item => item.mappingId === mappingId)

  async function submit() {
    if (disabled || busy.current || !mapping) return
    setError("")
    let input: RecordAnnotationCapabilityInput
    try { input = validateRecordAnnotationCapabilityInput({ revision: configuration.revision, mappingId, evidenceReference: reference.trim(), evidenceNote: note.trim(), confirmed }) }
    catch (error) { setError(error instanceof Error ? error.message : "请补全证据来源、说明与确认。"); return }
    busy.current = true
    setPending("record")
    try {
      await onRecord(input)
      if (active.current) { setReference(""); setNote(""); setConfirmed(false) }
    } catch (error) { if (active.current) setError(providerConfigurationErrorMessage(error)) }
    finally { busy.current = false; if (active.current) setPending(null) }
  }

  async function disableCapability() {
    if (disabled || busy.current || !record) return
    busy.current = true
    setPending("disable")
    setError("")
    try { await onDisable({ revision: configuration.revision, mappingId }); if (active.current) setConfirmed(false) }
    catch (error) { if (active.current) setError(providerConfigurationErrorMessage(error)) }
    finally { busy.current = false; if (active.current) setPending(null) }
  }

  return <section className="space-y-3 border-t border-border pt-5" aria-labelledby="annotation-capability-title">
    <h3 id="annotation-capability-title" className="text-sm font-medium">图片批注输入能力</h3>
    <p className="text-sm text-muted-foreground">先保存 API 设置，再依据服务商资料核对当前连接、接口、实际模型与 Token 对应权限，记录原图和编号标注图的双图输入契约。记录不会调用模型，也不代表真实编辑效果已验收。</p>
    <ul className="space-y-1 text-sm" aria-live="polite">{configuration.mappings.map(item => <li key={item.id}>{item.name}：{configuration.annotationCapabilities.some(capability => capability.mappingId === item.id) ? "已记录双图输入契约" : "未启用，批注不可用"}</li>)}</ul>
    {configuration.secretConfigured && configuration.mappings.length > 0 && <form aria-label="记录批注输入能力" onSubmit={event => { event.preventDefault(); void submit() }} aria-busy={pending !== null}>
      <fieldset disabled={disabled || pending !== null} className="min-w-0 space-y-3">
        <div className="space-y-1"><label htmlFor="provider-annotation-mapping" className="text-sm">已保存的模型映射</label><select id="provider-annotation-mapping" value={mappingId} onChange={event => setMappingId(event.target.value)} className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">{configuration.mappings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <p className="break-all text-xs text-muted-foreground">配置版本 {configuration.revision} · 实际模型：{mapping?.modelId}</p>
        {record && <div className="space-y-2"><p className="break-all text-xs text-muted-foreground">当前证据 {record.evidence.id} · {record.evidence.recordedAt} · <a href={record.evidence.reference} target="_blank" rel="noopener noreferrer" className="underline">查看来源</a> · {record.evidence.note}</p><p id="annotation-disable-help" className="text-xs text-muted-foreground">停用后禁止新的批注提交；普通生成和已受理任务保留。</p><Button type="button" variant="outline" aria-describedby="annotation-disable-help" onClick={() => void disableCapability()}>{pending === "disable" ? "正在停用…" : "停用批注能力"}</Button></div>}
        <div className="space-y-1"><label htmlFor="provider-annotation-reference" className="text-sm">证据来源（HTTPS）</label><Input id="provider-annotation-reference" type="url" value={reference} maxLength={2048} onChange={event => setReference(event.target.value)} placeholder="https://…" autoComplete="off" /></div>
        <div className="space-y-1"><label htmlFor="provider-annotation-note" className="text-sm">核验说明</label><textarea id="provider-annotation-note" value={note} maxLength={2000} onChange={event => setNote(event.target.value)} className="min-h-20 w-full rounded-md border border-border bg-background p-3 text-sm" placeholder="说明资料如何确认此连接、接口和模型支持两张图片作为输入" /></div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />我已核对当前已保存配置支持原图与编号标注图两张输入。</label>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <Button type="submit" disabled={!confirmed}>{pending === "record" ? "正在记录…" : "记录输入契约"}</Button>
      </fieldset>
    </form>}
    {disabled && <p className="text-xs text-muted-foreground">请先完成配置保存或重新载入核对，再记录能力证据。</p>}
  </section>
}
