import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import type { PoolClient } from "pg"
import {
  AnnotationCapabilityValidationError, publicAnnotationCapability, serializeAnnotationCapabilityBinding,
  serializeAnnotationCapabilityEvidence, serializeResolvedAnnotationCapabilityEvidence, validateAnnotationCapabilities, validatePublicAnnotationCapability,
  validateDisableAnnotationCapabilityInput,
  validateRecordAnnotationCapabilityInput, validateResolvedAnnotationCapability, type StoredAnnotationCapability,
} from "../lib/annotation-capability"
import { resolveGenerationProviderInTransaction } from "../lib/provider-configuration"
import { encryptProviderSecret } from "../lib/provider-secret"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const settings = { baseUrl: "https://synthetic.example/v1", apiMode: "images" as const, modelId: "synthetic-image", apiKey: "synthetic-token" }
const binding = () => hash(serializeAnnotationCapabilityBinding({ ...settings, tokenSha256: hash(`qintopia-image:annotation-token:v1\0${settings.apiKey}`) }))
function capability(): StoredAnnotationCapability {
  const value: StoredAnnotationCapability = { mappingId: "mapping-a", expression: "overlay-v1", maxInputImages: 2, configurationRevision: 4,
    bindingSha256: binding(), evidenceSha256: "0".repeat(64), evidence: { id: "11111111-1111-4111-8111-111111111111", actorId: "synthetic-admin", recordedAt: "2026-10-30T00:00:00.000Z", reference: "https://docs.example/images#two-inputs", note: "已核对当前网关接口及此模型的双图输入说明。", confirmed: true } }
  value.evidenceSha256 = hash(serializeAnnotationCapabilityEvidence(value))
  return value
}
const request = () => ({ revision: 4, mappingId: "mapping-a", evidenceReference: "https://docs.example/images", evidenceNote: "已核对当前 Token 对应配置的双图输入能力。", confirmed: true })

test("能力证据采用有界严格形状并深拷贝，拒绝不明确确认和不安全来源", () => {
  assert.deepEqual(validateRecordAnnotationCapabilityInput(request()), request())
  for (const invalid of [null, { ...request(), revision: 0 }, { ...request(), revision: 2_147_483_647 }, { ...request(), revision: NaN },
    { ...request(), confirmed: false }, { ...request(), confirmed: "true" }, { ...request(), token: "secret" },
    { ...request(), evidenceReference: "http://docs.example" }, { ...request(), evidenceReference: "https://name:secret@docs.example" },
    { ...request(), evidenceReference: "https://docs.example/" + "x".repeat(2048) }, { ...request(), evidenceNote: " " },
    { ...request(), evidenceNote: "x".repeat(2001) }, { ...request(), evidenceNote: "bad\u0000note" },
    { ...request(), mappingId: " mapping-a" }, { ...request(), mappingId: "x".repeat(129) },
  ]) assert.throws(() => validateRecordAnnotationCapabilityInput(invalid), AnnotationCapabilityValidationError)
  const original = capability()
  const copy = validateAnnotationCapabilities([original])
  copy[0].evidence.note = "本地修改"
  assert.notEqual(original.evidence.note, copy[0].evidence.note)
  assert.equal(validateRecordAnnotationCapabilityInput({ ...request(), evidenceNote: "x".repeat(2000) }).evidenceNote.length, 2000)
})

test("维护可复用记录校验拒绝重复、未知字段和非法revision/digest/time", () => {
  const value = capability()
  for (const invalid of [undefined, {}, [value, value], Array.from({ length: 101 }, () => value),
    [{ ...value, ownerId: "surprise" }], [{ ...value, configurationRevision: 0 }], [{ ...value, maxInputImages: 3 }],
    [{ ...value, bindingSha256: "ABC" }], [{ ...value, expression: "mask" }],
    [{ ...value, evidence: { ...value.evidence, recordedAt: "2026-02-30T00:00:00.000Z" } }],
    [{ ...value, evidence: { ...value.evidence, id: "not-uuid" } }], [{ ...value, evidence: { ...value.evidence, confirmed: false } }],
    [{ ...value, evidence: { ...value.evidence, unexpected: true } }],
  ]) assert.throws(() => validateAnnotationCapabilities(invalid), AnnotationCapabilityValidationError)
  const { mappingId: _mappingId, evidence: _evidence, ...resolved } = value
  assert.deepEqual(validateResolvedAnnotationCapability(resolved), resolved)
  assert.throws(() => validateResolvedAnnotationCapability(value), AnnotationCapabilityValidationError)
  assert.equal(serializeAnnotationCapabilityEvidence({ ...value, configurationRevision: 5 }), serializeAnnotationCapabilityEvidence(value), "名称/排序保存可继承原始证据摘要")
})

test("冻结来源完整深拷贝且按原证据摘要核对，仍接受原五字段历史快照", () => {
  const stored = capability()
  const { mappingId, evidence, ...legacy } = stored
  const frozen = { ...legacy, sourceEvidence: { mappingId, evidence } }
  const verification = { sha256: hash, mappingId, configurationRevision: 4 }
  const validated = validateResolvedAnnotationCapability(frozen, verification)
  assert.equal(serializeResolvedAnnotationCapabilityEvidence(validated), serializeAnnotationCapabilityEvidence(stored))
  assert.equal(serializeResolvedAnnotationCapabilityEvidence(legacy), null)
  assert.deepEqual(validateResolvedAnnotationCapability(legacy, verification), legacy)
  stored.evidence.note = "当前配置重录不会改动任务已冻结来源"
  assert.notEqual(validated.sourceEvidence!.evidence.note, stored.evidence.note)
  const mutations: Array<(value: typeof validated) => void> = [
    value => { value.sourceEvidence!.evidence.note = "篡改证据" },
    value => { value.sourceEvidence!.mappingId = "another-mapping" },
    value => { value.sourceEvidence!.evidence.reference = "https://changed.example" },
    value => { value.sourceEvidence!.evidence.actorId = "another-admin" },
    value => { value.sourceEvidence!.evidence.recordedAt = "2026-10-29T00:00:00.000Z" },
    value => { value.sourceEvidence!.evidence.id = "22222222-2222-4222-8222-222222222222" },
    value => { Object.assign(value.sourceEvidence!.evidence, { token: "forbidden" }) },
    value => { value.sourceEvidence = undefined },
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(validated); mutate(changed)
    assert.throws(() => validateResolvedAnnotationCapability(changed, verification), AnnotationCapabilityValidationError)
  }
  assert.throws(() => validateResolvedAnnotationCapability(validated, { ...verification, configurationRevision: 5 }), AnnotationCapabilityValidationError)
  assert.deepEqual(publicAnnotationCapability(validated), { available: true, expression: "overlay-v1", maxInputImages: 2, reason: null })
})

test("独立停用请求只接受已保存revision和映射，不能携带连接修改或覆盖证据", () => {
  assert.deepEqual(validateDisableAnnotationCapabilityInput({ revision: 4, mappingId: "mapping-a" }), { revision: 4, mappingId: "mapping-a" })
  for (const value of [null, { revision: 0, mappingId: "mapping-a" }, { revision: 2_147_483_647, mappingId: "mapping-a" },
    { revision: 4, mappingId: "" }, { revision: 4, mappingId: "mapping-a", apiKey: "secret" }, { revision: 4, mappingId: "mapping-a", confirmed: true }]) {
    assert.throws(() => validateDisableAnnotationCapabilityInput(value), AnnotationCapabilityValidationError)
  }
})

test("公共能力仅含安全状态，未知明确拒绝，不能混入内部摘要或证据", () => {
  const { mappingId: _mappingId, evidence: _evidence, ...resolved } = capability()
  assert.deepEqual(publicAnnotationCapability(resolved), { available: true, expression: "overlay-v1", maxInputImages: 2, reason: null })
  const unavailable = publicAnnotationCapability(null)
  assert.equal(unavailable.available, false)
  assert.ok(unavailable.reason)
  assert.deepEqual(validatePublicAnnotationCapability(unavailable), unavailable)
  for (const invalid of [undefined, { ...unavailable, available: true }, { ...unavailable, reason: null },
    { ...unavailable, expression: "overlay-v1" }, { ...unavailable, maxInputImages: 1 },
    { ...unavailable, evidence: capability().evidence }, { ...publicAnnotationCapability(resolved), bindingSha256: binding() },
  ]) assert.throws(() => validatePublicAnnotationCapability(invalid), AnnotationCapabilityValidationError)
})

test("真实配置解析仅接受当前revision、连接、接口、实际模型、Token及完整证据绑定", async t => {
  const originalKey = process.env.PROVIDER_CONFIG_KEY
  process.env.PROVIDER_CONFIG_KEY = Buffer.alloc(32, 47).toString("base64")
  t.after(() => { if (originalKey === undefined) delete process.env.PROVIDER_CONFIG_KEY; else process.env.PROVIDER_CONFIG_KEY = originalKey })
  const row = { baseUrl: settings.baseUrl, apiMode: settings.apiMode, tokenCiphertext: encryptProviderSecret(settings.apiKey),
    models: [], mappings: [{ id: "mapping-a", name: "名称", modelId: settings.modelId }], modelsSynced: false, revision: 4, annotationCapabilities: [capability()] }
  let current: typeof row = row
  let queries = 0
  const client = { query: async (sql: string) => { assert.match(sql, /FOR SHARE$/); queries++; return { rows: [current] } } } as unknown as PoolClient
  const frozen = (await resolveGenerationProviderInTransaction(client, "mapping-a", 4)).annotationCapability!
  assert.equal(frozen.expression, "overlay-v1")
  assert.deepEqual(frozen.sourceEvidence, { mappingId: "mapping-a", evidence: row.annotationCapabilities[0].evidence })
  assert.notEqual(frozen.sourceEvidence!.evidence, row.annotationCapabilities[0].evidence)
  assert.equal(hash(serializeResolvedAnnotationCapabilityEvidence(frozen)!), frozen.evidenceSha256)
  const changed = [
    { ...row, annotationCapabilities: [] }, { ...row, baseUrl: "https://other.example/v1" },
    { ...row, apiMode: "chat" as const }, { ...row, tokenCiphertext: encryptProviderSecret("synthetic-different-token") },
    { ...row, mappings: [{ ...row.mappings[0], modelId: "another-model" }] },
    { ...row, annotationCapabilities: [{ ...capability(), configurationRevision: 3 }] },
    { ...row, annotationCapabilities: [{ ...capability(), evidence: { ...capability().evidence, note: "证据被修改" } }] },
  ]
  for (const candidate of changed) {
    current = candidate as typeof row
    assert.equal((await resolveGenerationProviderInTransaction(client, "mapping-a", 4)).annotationCapability, null)
  }
  current = { ...row, tokenCiphertext: encryptProviderSecret(settings.apiKey), mappings: [{ ...row.mappings[0], name: "只修改名称" }] }
  assert.equal((await resolveGenerationProviderInTransaction(client, "mapping-a", 4)).annotationCapability?.bindingSha256, binding(), "同Token重新加密和展示名称不影响绑定")
  assert.equal(queries, 9)
})
