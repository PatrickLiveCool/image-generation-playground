import type { PoolClient } from "pg"
import { createHash, randomUUID } from "node:crypto"
import type { ModelMapping, ProviderApiMode, ProviderModel, ProviderSettings } from "./api-provider-types"
import type { AdminProviderConfiguration, ProviderConfigurationInput, PublicModelCatalog } from "./provider-configuration-types"
import { AccountError, invalidInput } from "./auth/errors"
import { accountIdentity, recheckAccount, requireAccount } from "./auth/guards"
import { getDatabase, withTransaction } from "./database"
import { endpointUrl, ProviderError, publicFetch } from "./provider-network"
import { decryptProviderSecret, encryptProviderSecret, providerConfigurationKey } from "./provider-secret"
import { upstreamError } from "./relay-image"
import { MAX_PROVIDER_JSON_BYTES, validateProviderConfiguration, validateProviderDraft, validateProviderRevision } from "./provider-configuration-validation"
export { MAX_PROVIDER_JSON_BYTES, validateProviderConfiguration } from "./provider-configuration-validation"
import { aspectRatiosForModel } from "../components/image-combiner/model-catalog"
import {
  AnnotationCapabilityValidationError, publicAnnotationCapability, serializeAnnotationCapabilityBinding,
  serializeAnnotationCapabilityEvidence, validateAnnotationCapabilities, validateRecordAnnotationCapabilityInput,
  validateDisableAnnotationCapabilityInput,
  type ResolvedAnnotationCapability, type StoredAnnotationCapability,
} from "./annotation-capability"

const PROVIDER_LOCK = 1_920_204_002
type StoredConfiguration = Omit<ProviderConfigurationInput, "settings"> & { baseUrl: string; apiMode: ProviderApiMode; tokenCiphertext: string; annotationCapabilities: StoredAnnotationCapability[] }
const columns = '"baseUrl","apiMode","tokenCiphertext",models,mappings,"modelsSynced",revision,"annotationCapabilities"'

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
function bindingSha256(settings: ProviderSettings, modelId: string): string {
  return sha256(serializeAnnotationCapabilityBinding({ baseUrl: settings.baseUrl, apiMode: settings.apiMode, modelId,
    tokenSha256: sha256(`qintopia-image:annotation-token:v1\0${settings.apiKey}`) }))
}

/** A stale or changed binding is unavailable; malformed persisted evidence is a configuration failure. */
function currentCapabilities(row: StoredConfiguration, token: string): StoredAnnotationCapability[] {
  try {
    return validateAnnotationCapabilities(row.annotationCapabilities).filter(capability => {
      const mapping = row.mappings.find(item => item.id === capability.mappingId)
      return mapping && capability.configurationRevision === row.revision
        && capability.bindingSha256 === bindingSha256({ baseUrl: row.baseUrl, apiMode: row.apiMode, apiKey: token }, mapping.modelId)
        && capability.evidenceSha256 === sha256(serializeAnnotationCapabilityEvidence(capability))
    })
  } catch (error) {
    if (error instanceof AnnotationCapabilityValidationError) throw new AccountError("PROVIDER_CAPABILITY_INVALID", 503, "批注能力记录无法核对，请联系管理员检查配置。")
    throw error
  }
}

function resolveAnnotationCapability(row: StoredConfiguration, mappingId: string, token: string): ResolvedAnnotationCapability | null {
  const capability = currentCapabilities(row, token).find(item => item.mappingId === mappingId)
  if (!capability) return null
  const { expression, maxInputImages, configurationRevision, bindingSha256, evidenceSha256 } = capability
  return { expression, maxInputImages, configurationRevision, bindingSha256, evidenceSha256,
    sourceEvidence: { mappingId: capability.mappingId, evidence: { ...capability.evidence } } }
}

async function storedConfiguration(client: Pick<PoolClient, "query">): Promise<StoredConfiguration | undefined> {
  const { rows: [row] } = await client.query<StoredConfiguration>(`SELECT ${columns} FROM app.provider_settings WHERE singleton=1`)
  return row
}

function safeView(row?: StoredConfiguration): AdminProviderConfiguration {
  // 管理员读取也验证实际密文，不能将损坏配置伪装成“已配置”。
  providerConfigurationKey()
  if (!row) return { revision: 0, settings: { baseUrl: "", apiKey: "", apiMode: "images" }, secretConfigured: false, models: [], mappings: [], modelsSynced: false, annotationCapabilities: [] }
  const token = decryptProviderSecret(row.tokenCiphertext)
  return { revision: row.revision, settings: { baseUrl: row.baseUrl, apiKey: "", apiMode: row.apiMode }, secretConfigured: true, models: row.models, mappings: row.mappings, modelsSynced: row.modelsSynced, annotationCapabilities: currentCapabilities(row, token) }
}

function assertRevision(expected: number, row?: StoredConfiguration) {
  if (expected !== (row?.revision ?? 0)) throw new AccountError("PROVIDER_REVISION_CONFLICT", 409, "模型配置已被其他管理员修改，请刷新后重新编辑。")
}

function resolveDraftToken(settings: ProviderSettings, row?: StoredConfiguration): string {
  // 已有配置损坏时，即使提交新 Token 也不能静默覆盖而掩盖恢复问题。
  const current = row ? decryptProviderSecret(row.tokenCiphertext) : (providerConfigurationKey(), undefined)
  if (settings.apiKey) return settings.apiKey
  if (!row || !current) throw invalidInput("首次保存或同步请填写 API Token。")
  if (settings.baseUrl !== row.baseUrl) throw invalidInput("更换 Base URL 后请重新输入 Token。")
  return current
}

export async function readAdminProvider(headers: Headers): Promise<AdminProviderConfiguration> {
  await requireAccount(headers, { admin: true })
  return safeView(await storedConfiguration(await getDatabase()))
}

export async function saveAdminProvider(headers: Headers, body: unknown): Promise<AdminProviderConfiguration> {
  const identity = await accountIdentity(headers, { admin: true })
  const input = validateProviderConfiguration(body)
  return withTransaction(async client => {
    await recheckAccount(client, identity, { admin: true })
    // 锁定固定职责而非不存在的行，保证两个 revision=0 的初始化不能都成功。
    await client.query("SELECT pg_advisory_xact_lock($1)", [PROVIDER_LOCK])
    const current = await storedConfiguration(client)
    assertRevision(input.revision, current)
    const token = resolveDraftToken(input.settings, current)
    const tokenCiphertext = encryptProviderSecret(token)
    const nextRevision = input.revision + 1
    const annotationCapabilities = current ? currentCapabilities(current, decryptProviderSecret(current.tokenCiphertext))
      .filter(capability => {
        const mapping = input.mappings.find(item => item.id === capability.mappingId)
        return mapping && capability.bindingSha256 === bindingSha256({ ...input.settings, apiKey: token }, mapping.modelId)
      }).map(capability => ({ ...capability, configurationRevision: nextRevision })) : []
    const { rows: [saved] } = await client.query<StoredConfiguration>(
      `INSERT INTO app.provider_settings (singleton,"baseUrl","tokenCiphertext","apiMode",models,mappings,"modelsSynced",revision,"updatedBy","annotationCapabilities")
       VALUES (1,$1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb)
       ON CONFLICT (singleton) DO UPDATE SET "baseUrl"=EXCLUDED."baseUrl","tokenCiphertext"=EXCLUDED."tokenCiphertext","apiMode"=EXCLUDED."apiMode",models=EXCLUDED.models,mappings=EXCLUDED.mappings,"modelsSynced"=EXCLUDED."modelsSynced",revision=EXCLUDED.revision,"updatedBy"=EXCLUDED."updatedBy","updatedAt"=now(),"annotationCapabilities"=EXCLUDED."annotationCapabilities"
       RETURNING ${columns}`,
      [input.settings.baseUrl, tokenCiphertext, input.settings.apiMode, JSON.stringify(input.models), JSON.stringify(input.mappings), input.modelsSynced, nextRevision, identity.user.id, JSON.stringify(annotationCapabilities)],
    )
    await client.query('INSERT INTO app.provider_config_audit ("actorId",revision,action) VALUES ($1,$2,$3)', [identity.user.id, nextRevision, "save"])
    return safeView(saved)
  })
}

/** Records an administrator's source-based input-contract check, without contacting a model. */
export async function recordAdminAnnotationCapability(headers: Headers, body: unknown): Promise<AdminProviderConfiguration> {
  const identity = await accountIdentity(headers, { admin: true })
  let input
  try { input = validateRecordAnnotationCapabilityInput(body) }
  catch (error) { throw invalidInput(error instanceof AnnotationCapabilityValidationError ? error.message : "批注能力记录格式无效。") }
  return withTransaction(async client => {
    await recheckAccount(client, identity, { admin: true })
    await client.query("SELECT pg_advisory_xact_lock($1)", [PROVIDER_LOCK])
    const current = await storedConfiguration(client)
    assertRevision(input.revision, current)
    if (!current) throw invalidInput("请先保存 API 配置，再记录批注能力。")
    const mapping = current.mappings.find(item => item.id === input.mappingId)
    if (!mapping) throw new AccountError("MODEL_MAPPING_NOT_FOUND", 409, "所选模型已被移除，请刷新核对。")
    const token = decryptProviderSecret(current.tokenCiphertext)
    const nextRevision = current.revision + 1
    const capability: StoredAnnotationCapability = {
      mappingId: mapping.id, expression: "overlay-v1", maxInputImages: 2, configurationRevision: nextRevision,
      bindingSha256: bindingSha256({ baseUrl: current.baseUrl, apiMode: current.apiMode, apiKey: token }, mapping.modelId),
      evidenceSha256: "0".repeat(64), evidence: { id: randomUUID(), actorId: identity.user.id, recordedAt: new Date().toISOString(), reference: input.evidenceReference, note: input.evidenceNote, confirmed: true },
    }
    capability.evidenceSha256 = sha256(serializeAnnotationCapabilityEvidence(capability))
    const capabilities = currentCapabilities(current, token).filter(item => item.mappingId !== mapping.id)
      .map(item => ({ ...item, configurationRevision: nextRevision }))
    capabilities.push(capability)
    const { rows: [saved] } = await client.query<StoredConfiguration>(
      `UPDATE app.provider_settings SET "annotationCapabilities"=$1::jsonb,revision=$2,"updatedBy"=$3,"updatedAt"=now() WHERE singleton=1 RETURNING ${columns}`,
      [JSON.stringify(capabilities), nextRevision, identity.user.id],
    )
    await client.query('INSERT INTO app.provider_config_audit ("actorId",revision,action) VALUES ($1,$2,$3)', [identity.user.id, nextRevision, "save"])
    return safeView(saved)
  })
}

/** Stops new annotation submissions; saved generation snapshots are never rewritten. */
export async function disableAdminAnnotationCapability(headers: Headers, body: unknown): Promise<AdminProviderConfiguration> {
  const identity = await accountIdentity(headers, { admin: true })
  let input
  try { input = validateDisableAnnotationCapabilityInput(body) }
  catch (error) { throw invalidInput(error instanceof AnnotationCapabilityValidationError ? error.message : "批注停用请求格式无效。") }
  return withTransaction(async client => {
    await recheckAccount(client, identity, { admin: true })
    await client.query("SELECT pg_advisory_xact_lock($1)", [PROVIDER_LOCK])
    const current = await storedConfiguration(client)
    assertRevision(input.revision, current)
    if (!current || !current.mappings.some(item => item.id === input.mappingId)) throw new AccountError("MODEL_MAPPING_NOT_FOUND", 409, "所选模型已被移除，请刷新核对。")
    const capabilities = currentCapabilities(current, decryptProviderSecret(current.tokenCiphertext))
    if (!capabilities.some(item => item.mappingId === input.mappingId)) throw new AccountError("ANNOTATION_CAPABILITY_UNAVAILABLE", 409, "当前模型的批注能力已不可用，请刷新核对。")
    const nextRevision = current.revision + 1
    const nextCapabilities = capabilities.filter(item => item.mappingId !== input.mappingId).map(item => ({ ...item, configurationRevision: nextRevision }))
    const { rows: [saved] } = await client.query<StoredConfiguration>(
      `UPDATE app.provider_settings SET "annotationCapabilities"=$1::jsonb,revision=$2,"updatedBy"=$3,"updatedAt"=now() WHERE singleton=1 RETURNING ${columns}`,
      [JSON.stringify(nextCapabilities), nextRevision, identity.user.id],
    )
    await client.query('INSERT INTO app.provider_config_audit ("actorId",revision,action) VALUES ($1,$2,$3)', [identity.user.id, nextRevision, "save"])
    return safeView(saved)
  })
}

export async function syncAdminProvider(headers: Headers, body: unknown, signal?: AbortSignal): Promise<{ models: ProviderModel[] }> {
  const identity = await accountIdentity(headers, { admin: true })
  const draft = validateProviderDraft(body)
  const settings = await withTransaction(async client => {
    await recheckAccount(client, identity, { admin: true })
    const current = await storedConfiguration(client)
    assertRevision(draft.revision, current)
    return { baseUrl: draft.baseUrl, apiMode: draft.apiMode, apiKey: resolveDraftToken(draft, current) }
  })
  const boundedSignal = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])])
  try {
    const response = await publicFetch(endpointUrl(settings.baseUrl, "models"), { headers: { Authorization: `Bearer ${settings.apiKey}` }, signal: boundedSignal }, MAX_PROVIDER_JSON_BYTES)
    if (!response.ok) throw upstreamError(response.status)
    // 读取网络分块时即执行目录的 2MiB 上限，解析前再次核对长度。
    const length = response.headers.get("content-length")
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_PROVIDER_JSON_BYTES)) throw new ProviderError("模型列表响应超过 2 MiB。", 502)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_PROVIDER_JSON_BYTES) throw new ProviderError("模型列表响应超过 2 MiB。", 502)
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    const data = value && typeof value === "object" && !Array.isArray(value) ? (value as { data?: unknown }).data : undefined
    if (!Array.isArray(data) || data.length > 5000) throw new ProviderError("中转需返回不超过 5000 项的标准模型列表，也可手动填写模型 ID。", 502)
    const ids = data.map(item => {
      const id: unknown = item && typeof item === "object" && !Array.isArray(item) ? item.id : undefined
      if (typeof id !== "string" || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) throw new ProviderError("中转返回了无效的模型 ID，也可手动填写。", 502)
      return id.trim()
    })
    return { models: [...new Set(ids)].sort().map(id => ({ id })) }
  } catch (error) {
    if (error instanceof ProviderError) throw new AccountError("PROVIDER_SYNC_FAILED", error.status, error.message)
    if (boundedSignal.aborted) throw new AccountError("PROVIDER_SYNC_TIMEOUT", 504, "同步模型超时或已取消，请重试。")
    throw new AccountError("PROVIDER_SYNC_FAILED", 502, "无法读取模型列表，请检查地址和网络；也可以手动填写模型 ID。")
  }
}

export async function readPublicModelCatalog(headers: Headers): Promise<PublicModelCatalog> {
  await requireAccount(headers)
  const view = safeView(await storedConfiguration(await getDatabase()))
  return { revision: view.revision, configured: view.secretConfigured && view.mappings.length > 0, apiMode: view.settings.apiMode, mappings: view.mappings.map(mapping => {
    const capability = view.annotationCapabilities.find(item => item.mappingId === mapping.id)
    return { id: mapping.id, name: mapping.name, aspectRatios: [...aspectRatiosForModel(mapping.modelId)], annotation: publicAnnotationCapability(capability ? {
      expression: capability.expression, maxInputImages: capability.maxInputImages, configurationRevision: capability.configurationRevision,
      bindingSha256: capability.bindingSha256, evidenceSha256: capability.evidenceSha256,
    } : null) }
  }) }
}

export async function resolveGenerationProvider(headers: Headers, mappingId: string): Promise<{ settings: ProviderSettings; mapping: ModelMapping; revision: number; annotationCapability: ResolvedAnnotationCapability | null }> {
  await requireAccount(headers)
  if (typeof mappingId !== "string" || !mappingId || mappingId.length > 128) throw invalidInput("请重新选择模型。")
  const row = await storedConfiguration(await getDatabase())
  if (!row) throw new AccountError("PROVIDER_NOT_CONFIGURED", 503, "管理员尚未配置可用模型。")
  const mapping = row.mappings.find(item => item.id === mappingId)
  if (!mapping) throw new AccountError("MODEL_MAPPING_NOT_FOUND", 409, "所选模型已被移除，请重新选择。")
  const token = decryptProviderSecret(row.tokenCiphertext)
  return { settings: { baseUrl: row.baseUrl, apiMode: row.apiMode, apiKey: token }, mapping, revision: row.revision, annotationCapability: resolveAnnotationCapability(row, mappingId, token) }
}

/** 在任务受理事务内固定配置；调用方必须已复核身份，且只对新请求调用。 */
export async function resolveGenerationProviderInTransaction(client: PoolClient, mappingId: string, expectedRevision: number): Promise<{ settings: ProviderSettings; mapping: ModelMapping; revision: number; annotationCapability: ResolvedAnnotationCapability | null }> {
  if (typeof mappingId !== "string" || !mappingId || mappingId.length > 128) throw invalidInput("请重新选择模型。")
  validateProviderRevision(expectedRevision)
  // 与管理员更新行互斥，直到任务和配置快照一并提交；Token 仅返回给首次执行者。
  const { rows: [row] } = await client.query<StoredConfiguration>(`SELECT ${columns} FROM app.provider_settings WHERE singleton=1 FOR SHARE`)
  if (!row) throw new AccountError("PROVIDER_NOT_CONFIGURED", 503, "管理员尚未配置可用模型。")
  assertRevision(expectedRevision, row)
  const mapping = row.mappings.find(item => item.id === mappingId)
  if (!mapping) throw new AccountError("MODEL_MAPPING_NOT_FOUND", 409, "所选模型已被移除，请重新选择。")
  const token = decryptProviderSecret(row.tokenCiphertext)
  return { settings: { baseUrl: row.baseUrl, apiMode: row.apiMode, apiKey: token }, mapping, revision: row.revision, annotationCapability: resolveAnnotationCapability(row, mappingId, token) }
}
