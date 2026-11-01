import { randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import { aspectRatiosForModel } from "../components/image-combiner/model-catalog"
import { AccountError, invalidInput } from "./auth/errors"
import { accountIdentity, recheckAccount, type AccountIdentity } from "./auth/guards"
import { withTransaction } from "./database"
import { acquireGenerationSlotInTransaction } from "./generation-admission"
import { assertPrivateKey, privateRunPrefix } from "./private-cos"
import type { AcceptedPrivateRun, PrivateAssetRecord, PrivateRunRecord, RunCommand } from "./private-workspace-records"
import type { PrivateCreation, PrivateRun, PrivateRunStatus } from "./private-workspace-types"
import { resolveGenerationProviderInTransaction } from "./provider-configuration"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const FAILURE_CODES = new Set(["INPUT_SAVE_FAILED", "GENERATION_FAILED", "GENERATION_UNKNOWN", "OUTPUT_SAVE_FAILED", "MANIFEST_SAVE_FAILED", "METADATA_SAVE_FAILED", "REQUEST_ABORTED", "REPAIR_OUTPUT_MISSING", "REPAIR_INVALID_OUTPUT", "BASE_VERSION_UNAVAILABLE", "REFERENCE_INVALID", "ACCOUNT_UNAVAILABLE", "MODEL_OUTPUT_INVALID", "PROVIDER_AUTH_REJECTED", "PROVIDER_REQUEST_REJECTED", "PROVIDER_RATE_LIMITED", "PROVIDER_UPSTREAM_FAILED", "INPUT_READ_FAILED"])
const RUN_STATUSES = new Set<PrivateRunStatus>(["preparing", "generating", "saving", "complete", "failed", "unknown", "save_pending"])
type CreationRow = { id: string; title: string; revision: number; nextVersion: number; createdAt: Date; updatedAt: Date }
type RunRow = Omit<PrivateRun, "createdAt" | "updatedAt" | "imageUrl" | "document" | "failureCode"> & {
  ownerId: string; clientRequestId: string; fingerprint: string; createdAt: Date; updatedAt: Date; deadlineAt: Date
  manifestKey: string; outputKey: string; outputAssetId: string; failureCode: string | null
  providerBaseUrl: string; providerApiMode: PrivateRunRecord["provider"]["apiMode"]; providerModelId: string; providerRevision: number
  documentAssetId?: string | null; documentName?: string | null
}
const runSelect = `SELECT r.*, c.revision AS "creationRevision", d.id AS "documentAssetId", d.name AS "documentName"
  FROM app.generation_runs r JOIN app.creations c ON c."ownerId"=r."ownerId" AND c.id=r."creationId"
  LEFT JOIN app.private_assets d ON d."ownerId"=r."ownerId" AND d."runId"=r.id AND d.kind='document'`

function identifier(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalidInput("创作或任务标识无效。")
  return value.toLowerCase()
}
function notFound(): never { throw new AccountError("NOT_FOUND", 404, "内容不存在。") }
function lookupIdentifier(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return notFound()
  return value.toLowerCase()
}
function exactBody(body: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => !required.includes(key) && !optional.includes(key))) throw invalidInput()
  return body as Record<string, unknown>
}
function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(value)) throw invalidInput("创作名称须为 1–60 个字符。")
  return value.trim()
}
function toRecord(row: RunRow): PrivateRunRecord {
  const expired = row.deadlineAt.getTime() <= Date.now() && ["preparing", "generating", "saving"].includes(row.status)
  const visible: PrivateRun = {
    id: row.id, creationId: row.creationId, creationRevision: row.creationRevision, version: row.version, parentVersionId: row.parentVersionId,
    status: expired ? "unknown" : row.status, imageUrl: row.status === "complete" ? `/api/images/${row.outputAssetId}` : null,
    prompt: row.prompt, mappingId: row.mappingId, modelLabel: row.modelLabel, aspectRatio: row.aspectRatio,
    quality: row.quality, mode: row.mode, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
    ...(row.failureCode && FAILURE_CODES.has(row.failureCode) ? { failureCode: row.failureCode } : {}),
    ...(row.documentAssetId ? { document: { assetId: row.documentAssetId, name: row.documentName || "未命名文档" } } : {}),
  }
  return { public: visible, ownerId: row.ownerId, fingerprint: row.fingerprint, deadlineAt: row.deadlineAt.getTime(), manifestKey: row.manifestKey, outputKey: row.outputKey, outputAssetId: row.outputAssetId,
    provider: { baseUrl: row.providerBaseUrl, apiMode: row.providerApiMode, modelId: row.providerModelId, revision: row.providerRevision } }
}
async function findRun(client: PoolClient, ownerId: string, id: string, lock = false): Promise<RunRow | undefined> {
  const { rows: [row] } = await client.query<RunRow>(`${runSelect} WHERE r."ownerId"=$1 AND r.id=$2${lock ? " FOR UPDATE OF r" : ""}`, [ownerId, id])
  return row
}
async function creationView(client: PoolClient, ownerId: string, row: CreationRow): Promise<PrivateCreation> {
  const { rows } = await client.query<RunRow>(`${runSelect} WHERE r."ownerId"=$1 AND r."creationId"=$2 ORDER BY r.version`, [ownerId, row.id])
  return { id: row.id, title: row.title, revision: row.revision, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(), versions: rows.map(run => toRecord(run).public) }
}

export async function listPrivateCreations(headers: Headers): Promise<PrivateCreation[]> {
  const identity = await accountIdentity(headers)
  return withTransaction(async client => {
    await recheckAccount(client, identity)
    const { rows } = await client.query<CreationRow>('SELECT * FROM app.creations WHERE "ownerId"=$1 ORDER BY "updatedAt" DESC,id', [identity.user.id])
    const creations: PrivateCreation[] = []
    for (const row of rows) creations.push(await creationView(client, identity.user.id, row))
    return creations
  })
}
export async function createPrivateCreation(headers: Headers, body: unknown): Promise<PrivateCreation> {
  const identity = await accountIdentity(headers)
  const input = exactBody(body, ["id"], ["title"])
  const id = identifier(input.id), name = input.title === undefined ? "未命名创作" : title(input.title)
  return withTransaction(async client => {
    await recheckAccount(client, identity)
    await client.query('INSERT INTO app.creations ("ownerId",id,title) VALUES ($1,$2,$3) ON CONFLICT ("ownerId",id) DO NOTHING', [identity.user.id, id, name])
    const { rows: [row] } = await client.query<CreationRow>('SELECT * FROM app.creations WHERE "ownerId"=$1 AND id=$2', [identity.user.id, id])
    return creationView(client, identity.user.id, row)
  })
}
export async function readPrivateCreation(headers: Headers, id: string): Promise<PrivateCreation> {
  const identity = await accountIdentity(headers), creationId = lookupIdentifier(id)
  return withTransaction(async client => {
    await recheckAccount(client, identity)
    const { rows: [row] } = await client.query<CreationRow>('SELECT * FROM app.creations WHERE "ownerId"=$1 AND id=$2', [identity.user.id, creationId])
    if (!row) return notFound()
    return creationView(client, identity.user.id, row)
  })
}
export async function renamePrivateCreation(headers: Headers, id: string, body: unknown): Promise<PrivateCreation> {
  const identity = await accountIdentity(headers), creationId = identifier(id)
  const input = exactBody(body, ["revision", "title"]), name = title(input.title)
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1 || (input.revision as number) >= 2_147_483_647) throw invalidInput("创作版本无效。")
  return withTransaction(async client => {
    await recheckAccount(client, identity)
    const { rows: [current] } = await client.query<CreationRow>('SELECT * FROM app.creations WHERE "ownerId"=$1 AND id=$2 FOR UPDATE', [identity.user.id, creationId])
    if (!current) return notFound()
    if (current.revision !== input.revision) throw new AccountError("CREATION_REVISION_CONFLICT", 409, "创作已在其他设备更新，请刷新后重试。")
    const { rows: [row] } = await client.query<CreationRow>('UPDATE app.creations SET title=$3,revision=revision+1,"updatedAt"=statement_timestamp() WHERE "ownerId"=$1 AND id=$2 RETURNING *', [identity.user.id, creationId, name])
    return creationView(client, identity.user.id, row)
  })
}

function validateCommand(command: RunCommand): RunCommand {
  const value = exactBody(command, ["creationId", "clientRequestId", "fingerprint", "parentVersionId", "mappingId", "configRevision", "prompt", "aspectRatio", "quality", "mode"])
  if (typeof value.fingerprint !== "string" || !HASH.test(value.fingerprint) || typeof value.mappingId !== "string" || !value.mappingId || value.mappingId.length > 128 ||
      !Number.isSafeInteger(value.configRevision) || (value.configRevision as number) < 1 || (value.configRevision as number) >= 2_147_483_647 ||
      typeof value.prompt !== "string" || value.prompt.length > 5000 || value.prompt.includes("\u0000") ||
      typeof value.aspectRatio !== "string" || !value.aspectRatio || value.aspectRatio.length > 32 ||
      !["auto", "low", "medium", "high"].includes(value.quality as string) || !["text-to-image", "image-editing"].includes(value.mode as string)) throw invalidInput("生成参数无效。")
  const normalized = { ...command, creationId: identifier(command.creationId), clientRequestId: identifier(command.clientRequestId), parentVersionId: command.parentVersionId === null ? null : identifier(command.parentVersionId) }
  if (normalized.parentVersionId && normalized.mode !== "image-editing") throw invalidInput("历史版本修改必须提交原始图片。")
  return normalized
}
async function baseInTransaction(client: PoolClient, ownerId: string, creationId: string, parentId: string): Promise<PrivateAssetRecord> {
  const { rows: [asset] } = await client.query<PrivateAssetRecord>(`SELECT a.* FROM app.generation_runs r JOIN app.private_assets a ON a."ownerId"=r."ownerId" AND a.id=r."outputAssetId" AND a."runId"=r.id AND a."creationId"=r."creationId" AND a.key=r."outputKey" AND a.kind='image'
    WHERE r."ownerId"=$1 AND r."creationId"=$2 AND r.id=$3 AND r.status='complete'`, [ownerId, creationId, parentId])
  if (!asset) throw new AccountError("BASE_VERSION_UNAVAILABLE", 409, "所选原始图片不可用，请重新选择成功版本。")
  return assetView(asset)
}
function assetView(asset: PrivateAssetRecord): PrivateAssetRecord {
  return { id: asset.id, ownerId: asset.ownerId, creationId: asset.creationId, runId: asset.runId, key: asset.key, kind: asset.kind, mediaType: asset.mediaType, byteLength: asset.byteLength, sha256: asset.sha256, ...(asset.name ? { name: asset.name } : {}) }
}
export async function acceptPrivateRun(identity: AccountIdentity, command: RunCommand): Promise<AcceptedPrivateRun> {
  const input = validateCommand(command), ownerId = identity.user.id
  return withTransaction(async client => {
    await recheckAccount(client, identity)
    const existing = await findRun(client, ownerId, input.clientRequestId)
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new AccountError("GENERATION_REQUEST_CONFLICT", 409, "该请求标识已用于其他生成内容，请使用新的请求。")
      return { acquired: false, record: toRecord(existing) }
    }
    // 新创作只会由明确创建或首次提交建立；失败受理会回滚此插入。
    await client.query('INSERT INTO app.creations ("ownerId",id,title) VALUES ($1,$2,$3) ON CONFLICT ("ownerId",id) DO NOTHING', [ownerId, input.creationId, "未命名创作"])
    const { rows: [creation] } = await client.query<CreationRow>('SELECT * FROM app.creations WHERE "ownerId"=$1 AND id=$2 FOR UPDATE', [ownerId, input.creationId])
    if (input.parentVersionId) await baseInTransaction(client, ownerId, input.creationId, input.parentVersionId)
    const provider = await resolveGenerationProviderInTransaction(client, input.mappingId, input.configRevision)
    if (!aspectRatiosForModel(provider.mapping.modelId).includes(input.aspectRatio)) throw invalidInput("所选模型不支持该图片比例。")
    const slot = await acquireGenerationSlotInTransaction(client, { userId: ownerId, requestId: input.clientRequestId, fingerprint: input.fingerprint })
    if (!slot.acquired) throw new AccountError("GENERATION_REQUEST_CONFLICT", 409, "该请求已受理，请查询原任务状态。")
    const prefix = privateRunPrefix(ownerId, input.creationId, input.clientRequestId), outputAssetId = randomUUID()
    await client.query(`INSERT INTO app.generation_runs ("ownerId",id,"creationId","clientRequestId",fingerprint,version,"parentVersionId",status,prompt,"mappingId","modelLabel","aspectRatio",quality,mode,"providerBaseUrl","providerApiMode","providerModelId","providerRevision","manifestKey","outputKey","outputAssetId","deadlineAt")
      SELECT $1,$2,$3,$2,$4,$5,$6,'preparing',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,"deadlineAt" FROM app.provider_request_slots WHERE "userId"=$1 AND "requestId"=$2`,
    [ownerId, input.clientRequestId, input.creationId, input.fingerprint, creation.nextVersion, input.parentVersionId, input.prompt, input.mappingId, provider.mapping.name, input.aspectRatio, input.quality, input.mode, provider.settings.baseUrl, provider.settings.apiMode, provider.mapping.modelId, provider.revision, `${prefix}/manifest.json`, `${prefix}/outputs/final`, outputAssetId])
    await client.query('UPDATE app.creations SET "nextVersion"="nextVersion"+1,revision=revision+1,"updatedAt"=statement_timestamp() WHERE "ownerId"=$1 AND id=$2', [ownerId, input.creationId])
    return { acquired: true, record: toRecord((await findRun(client, ownerId, input.clientRequestId))!), settings: provider.settings }
  })
}
export async function readPrivateRun(identity: AccountIdentity, id: string): Promise<PrivateRunRecord> {
  const runId = lookupIdentifier(id)
  return withTransaction(async client => {
    await recheckAccount(client, identity)
    const row = await findRun(client, identity.user.id, runId)
    return row ? toRecord(row) : notFound()
  })
}
export async function readPrivateAsset(identity: AccountIdentity, id: string, kind?: PrivateAssetRecord["kind"]): Promise<PrivateAssetRecord> {
  const assetId = lookupIdentifier(id)
  return withTransaction(async client => {
    await recheckAccount(client, identity)
    const { rows: [row] } = await client.query<PrivateAssetRecord>('SELECT * FROM app.private_assets WHERE "ownerId"=$1 AND id=$2', [identity.user.id, assetId])
    if (!row || (kind && row.kind !== kind)) return notFound()
    return assetView(row)
  })
}
export async function readPrivateBase(identity: AccountIdentity, creationId: string, parentVersionId: string | null): Promise<PrivateAssetRecord | null> {
  const creation = identifier(creationId), parent = parentVersionId === null ? null : identifier(parentVersionId)
  return withTransaction(async client => {
    await recheckAccount(client, identity)
    return parent ? baseInTransaction(client, identity.user.id, creation, parent) : null
  })
}

export async function setPrivateRunStatus(ownerId: string, runId: string, status: PrivateRunStatus, failureCode?: string): Promise<void> {
  const id = identifier(runId)
  if (!RUN_STATUSES.has(status) || status === "complete" || (failureCode !== undefined && !FAILURE_CODES.has(failureCode))) throw invalidInput("任务状态无效。")
  await withTransaction(async client => {
    const row = await findRun(client, ownerId, id, true)
    if (!row) return notFound()
    if (row.status === "complete") return
    const progress = ["preparing", "generating", "saving"]
    if (progress.includes(status) && (!progress.includes(row.status) || progress.indexOf(status) < progress.indexOf(row.status))) return
    if ((row.status === "save_pending" || row.status === "unknown") && status === "failed") return
    if (row.status === "save_pending" && status === "unknown") return
    await client.query('UPDATE app.generation_runs SET status=$3,"failureCode"=$4,"updatedAt"=statement_timestamp() WHERE "ownerId"=$1 AND id=$2', [ownerId, id, status, failureCode ?? null])
    if (["failed", "unknown", "save_pending"].includes(status)) {
      await client.query('UPDATE app.provider_request_slots SET status=$3 WHERE "userId"=$1 AND "requestId"=$2 AND status<>\'finished\'', [ownerId, row.clientRequestId, status === "failed" ? "finished" : "unknown"])
    }
  })
}

function validAssets(row: RunRow, assets: PrivateAssetRecord[]): void {
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > 6) throw invalidInput("保存记录无效。")
  const prefix = privateRunPrefix(row.ownerId, row.creationId, row.id)
  const ids = new Set<string>(), keys = new Set<string>()
  let outputs = 0
  for (const asset of assets) {
    if (!asset || identifier(asset.id) !== asset.id || asset.ownerId !== row.ownerId || asset.creationId !== row.creationId || asset.runId !== row.id || typeof asset.key !== "string" || !asset.key.startsWith(`${prefix}/`) || !HASH.test(asset.sha256) ||
        !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || asset.byteLength > (asset.kind === "document" ? 10 : 20) * 1024 * 1024 ||
        typeof asset.mediaType !== "string" || asset.mediaType.length > 128 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;charset=utf-8)?$/i.test(asset.mediaType) ||
        (asset.name !== undefined && (typeof asset.name !== "string" || !asset.name || asset.name.length > 255 || /[\u0000-\u001f\u007f]/.test(asset.name))) || ids.has(asset.id) || keys.has(asset.key)) throw invalidInput("保存记录无效。")
    assertPrivateKey(asset.key)
    const suffix = asset.key.slice(prefix.length + 1)
    if (suffix === "outputs/final") {
      if (asset.id !== row.outputAssetId || asset.key !== row.outputKey || asset.kind !== "image") throw invalidInput("输出记录不匹配。")
      outputs += 1
    } else if (suffix === "inputs/document") {
      if (asset.kind !== "document" || !asset.name || asset.id === row.outputAssetId) throw invalidInput("文档记录不匹配。")
    } else if (/^inputs\/(?:reference-[12]|document-image-[12])$/.test(suffix)) {
      if (asset.kind !== "image" || asset.id === row.outputAssetId) throw invalidInput("图片记录不匹配。")
    } else throw invalidInput("保存路径不匹配。")
    if (asset.kind === "image" && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(asset.mediaType)) throw invalidInput("图片格式无效。")
    ids.add(asset.id); keys.add(asset.key)
  }
  if (outputs !== 1) throw invalidInput("成功任务缺少输出图片。")
}
export async function completePrivateRun(ownerId: string, runId: string, assets: PrivateAssetRecord[]): Promise<PrivateRun> {
  const id = identifier(runId)
  return withTransaction(async client => {
    const row = await findRun(client, ownerId, id, true)
    if (!row) return notFound()
    // 已成功后的重复修复只返回原结果，既不新增资产，也不改写首次成功数据。
    if (row.status === "complete") {
      // FOR UPDATE 可能等待另一补记事务：任务行会读取其新状态，但该语句
      // JOIN 的创作/资产快照仍早于等待；另起语句读取当前revision和完整文档元数据。
      return toRecord((await findRun(client, ownerId, id))!).public
    }
    validAssets(row, assets)
    for (const asset of assets) await client.query(`INSERT INTO app.private_assets ("ownerId",id,"creationId","runId",key,kind,"mediaType","byteLength",sha256,name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [ownerId, asset.id, row.creationId, id, asset.key, asset.kind, asset.mediaType, asset.byteLength, asset.sha256, asset.name ?? null])
    await client.query('UPDATE app.generation_runs SET status=\'complete\',"failureCode"=NULL,"updatedAt"=statement_timestamp() WHERE "ownerId"=$1 AND id=$2', [ownerId, id])
    // unknown 也可以由确定存在且校验过的输出修复为 finished，随后立即释放受理槽。
    await client.query('UPDATE app.provider_request_slots SET status=\'finished\' WHERE "userId"=$1 AND "requestId"=$2', [ownerId, row.clientRequestId])
    await client.query('UPDATE app.creations SET revision=revision+1,"updatedAt"=statement_timestamp() WHERE "ownerId"=$1 AND id=$2', [ownerId, row.creationId])
    return toRecord((await findRun(client, ownerId, id))!).public
  })
}
