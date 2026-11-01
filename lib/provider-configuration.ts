import type { PoolClient } from "pg"
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

const PROVIDER_LOCK = 1_920_204_002
type StoredConfiguration = Omit<ProviderConfigurationInput, "settings"> & { baseUrl: string; apiMode: ProviderApiMode; tokenCiphertext: string }
const columns = '"baseUrl","apiMode","tokenCiphertext",models,mappings,"modelsSynced",revision'

async function storedConfiguration(client: Pick<PoolClient, "query">): Promise<StoredConfiguration | undefined> {
  const { rows: [row] } = await client.query<StoredConfiguration>(`SELECT ${columns} FROM app.provider_settings WHERE singleton=1`)
  return row
}

function safeView(row?: StoredConfiguration): AdminProviderConfiguration {
  // 管理员读取也验证实际密文，不能将损坏配置伪装成“已配置”。
  providerConfigurationKey()
  if (!row) return { revision: 0, settings: { baseUrl: "", apiKey: "", apiMode: "images" }, secretConfigured: false, models: [], mappings: [], modelsSynced: false }
  decryptProviderSecret(row.tokenCiphertext)
  return { revision: row.revision, settings: { baseUrl: row.baseUrl, apiKey: "", apiMode: row.apiMode }, secretConfigured: true, models: row.models, mappings: row.mappings, modelsSynced: row.modelsSynced }
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
    const tokenCiphertext = encryptProviderSecret(resolveDraftToken(input.settings, current))
    const nextRevision = input.revision + 1
    const { rows: [saved] } = await client.query<StoredConfiguration>(
      `INSERT INTO app.provider_settings (singleton,"baseUrl","tokenCiphertext","apiMode",models,mappings,"modelsSynced",revision,"updatedBy")
       VALUES (1,$1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)
       ON CONFLICT (singleton) DO UPDATE SET "baseUrl"=EXCLUDED."baseUrl","tokenCiphertext"=EXCLUDED."tokenCiphertext","apiMode"=EXCLUDED."apiMode",models=EXCLUDED.models,mappings=EXCLUDED.mappings,"modelsSynced"=EXCLUDED."modelsSynced",revision=EXCLUDED.revision,"updatedBy"=EXCLUDED."updatedBy","updatedAt"=now()
       RETURNING ${columns}`,
      [input.settings.baseUrl, tokenCiphertext, input.settings.apiMode, JSON.stringify(input.models), JSON.stringify(input.mappings), input.modelsSynced, nextRevision, identity.user.id],
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
  return { revision: view.revision, configured: view.secretConfigured && view.mappings.length > 0, apiMode: view.settings.apiMode, mappings: view.mappings.map(mapping => ({ id: mapping.id, name: mapping.name, aspectRatios: [...aspectRatiosForModel(mapping.modelId)] })) }
}

export async function resolveGenerationProvider(headers: Headers, mappingId: string): Promise<{ settings: ProviderSettings; mapping: ModelMapping; revision: number }> {
  await requireAccount(headers)
  if (typeof mappingId !== "string" || !mappingId || mappingId.length > 128) throw invalidInput("请重新选择模型。")
  const row = await storedConfiguration(await getDatabase())
  if (!row) throw new AccountError("PROVIDER_NOT_CONFIGURED", 503, "管理员尚未配置可用模型。")
  const mapping = row.mappings.find(item => item.id === mappingId)
  if (!mapping) throw new AccountError("MODEL_MAPPING_NOT_FOUND", 409, "所选模型已被移除，请重新选择。")
  return { settings: { baseUrl: row.baseUrl, apiMode: row.apiMode, apiKey: decryptProviderSecret(row.tokenCiphertext) }, mapping, revision: row.revision }
}

/** 在任务受理事务内固定配置；调用方必须已复核身份，且只对新请求调用。 */
export async function resolveGenerationProviderInTransaction(client: PoolClient, mappingId: string, expectedRevision: number): Promise<{ settings: ProviderSettings; mapping: ModelMapping; revision: number }> {
  if (typeof mappingId !== "string" || !mappingId || mappingId.length > 128) throw invalidInput("请重新选择模型。")
  validateProviderRevision(expectedRevision)
  // 与管理员更新行互斥，直到任务和配置快照一并提交；Token 仅返回给首次执行者。
  const { rows: [row] } = await client.query<StoredConfiguration>(`SELECT ${columns} FROM app.provider_settings WHERE singleton=1 FOR SHARE`)
  if (!row) throw new AccountError("PROVIDER_NOT_CONFIGURED", 503, "管理员尚未配置可用模型。")
  assertRevision(expectedRevision, row)
  const mapping = row.mappings.find(item => item.id === mappingId)
  if (!mapping) throw new AccountError("MODEL_MAPPING_NOT_FOUND", 409, "所选模型已被移除，请重新选择。")
  return { settings: { baseUrl: row.baseUrl, apiMode: row.apiMode, apiKey: decryptProviderSecret(row.tokenCiphertext) }, mapping, revision: row.revision }
}
