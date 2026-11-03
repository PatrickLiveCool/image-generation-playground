import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import type { PoolClient } from "pg"
import {
  AnnotationCapabilityValidationError, publicAnnotationCapability, serializeAnnotationCapabilityBinding,
  serializeAnnotationCapabilityEvidence, serializeResolvedAnnotationCapabilityEvidence, validateAnnotationCapabilities, validatePublicAnnotationCapability,
  createDefaultAnnotationCapability, serializeDefaultAnnotationPolicy, validateResolvedAnnotationCapability, type StoredAnnotationCapability,
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
test("历史管理员证据仍有界校验并深拷贝，不把损坏来源混入旧记录", () => {
  const original = capability()
  const copy = validateAnnotationCapabilities([original])
  copy[0].evidence.note = "本地修改"
  assert.notEqual(original.evidence.note, copy[0].evidence.note)
  for (const evidence of [
    { ...original.evidence, reference: "http://docs.example" },
    { ...original.evidence, reference: "https://name:secret@docs.example" },
    { ...original.evidence, reference: "https://docs.example/" + "x".repeat(2048) },
    { ...original.evidence, note: " " }, { ...original.evidence, note: "x".repeat(2001) },
    { ...original.evidence, note: "bad\u0000note" }, { ...original.evidence, confirmed: false },
  ]) assert.throws(() => validateAnnotationCapabilities([{ ...original, evidence }]), AnnotationCapabilityValidationError)
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

test("默认批注冻结应用策略和当前连接，不伪造管理员核验证据", () => {
  const result = createDefaultAnnotationCapability(4, binding(), hash)
  assert.deepEqual(Object.keys(result).sort(), ["bindingSha256", "configurationRevision", "evidenceSha256", "expression", "maxInputImages"])
  assert.equal(result.sourceEvidence, undefined)
  assert.equal(serializeResolvedAnnotationCapabilityEvidence(result), null)
  assert.equal(result.evidenceSha256, hash(serializeDefaultAnnotationPolicy(binding())))
  const policy = JSON.parse(serializeDefaultAnnotationPolicy(binding()))
  assert.equal(policy.source, "application-default")
  assert.deepEqual(policy.inputs, ["original", "overlay"])
  assert.doesNotMatch(JSON.stringify(result), /actorId|confirmed|reference|recordedAt|mappingId/)
  assert.deepEqual(validateResolvedAnnotationCapability(result, { sha256: hash, mappingId: "mapping-a", configurationRevision: 4 }), result)
  assert.notEqual(createDefaultAnnotationCapability(4, "1".repeat(64), hash).evidenceSha256, result.evidenceSha256)
  for (const [revision, digest] of [[0, binding()], [4, "invalid"]] as const) {
    assert.throws(() => createDefaultAnnotationCapability(revision, digest, hash), AnnotationCapabilityValidationError)
  }
})

test("公共状态保持旧客户端兼容且不能混入内部摘要或历史证据", () => {
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

test("真实配置解析默认支持批注，冻结当前连接而不依赖历史人工证据", async t => {
  const originalKey = process.env.PROVIDER_CONFIG_KEY
  process.env.PROVIDER_CONFIG_KEY = Buffer.alloc(32, 47).toString("base64")
  t.after(() => { if (originalKey === undefined) delete process.env.PROVIDER_CONFIG_KEY; else process.env.PROVIDER_CONFIG_KEY = originalKey })
  const row = { baseUrl: settings.baseUrl, apiMode: settings.apiMode, tokenCiphertext: encryptProviderSecret(settings.apiKey),
    models: [], mappings: [{ id: "mapping-a", name: "名称", modelId: settings.modelId }], modelsSynced: false, revision: 4, annotationCapabilities: [] as StoredAnnotationCapability[] }
  let current: Omit<typeof row, "apiMode"> & { apiMode: "images" | "chat" } = row
  const client = { query: async (sql: string) => { assert.match(sql, /FOR SHARE$/); return { rows: [current] } } } as unknown as PoolClient
  const frozen = (await resolveGenerationProviderInTransaction(client, "mapping-a", 4)).annotationCapability
  assert.equal(frozen.expression, "overlay-v1")
  assert.equal(frozen.sourceEvidence, undefined)
  assert.equal(frozen.bindingSha256, binding())
  assert.equal(frozen.evidenceSha256, hash(serializeDefaultAnnotationPolicy(binding())))
  for (const annotationCapabilities of [[capability()], [{ ...capability(), configurationRevision: 3 }]]) {
    current = { ...row, annotationCapabilities }
    assert.deepEqual((await resolveGenerationProviderInTransaction(client, "mapping-a", 4)).annotationCapability, frozen)
  }
  for (const candidate of [
    { ...row, baseUrl: "https://other.example/v1" }, { ...row, apiMode: "chat" as const },
    { ...row, tokenCiphertext: encryptProviderSecret("synthetic-different-token") },
    { ...row, mappings: [{ ...row.mappings[0], modelId: "another-model" }] },
  ]) {
    current = candidate
    const resolved = (await resolveGenerationProviderInTransaction(client, "mapping-a", 4)).annotationCapability
    assert.equal(resolved.expression, "overlay-v1")
    assert.notEqual(resolved.bindingSha256, frozen.bindingSha256)
    assert.notEqual(resolved.evidenceSha256, frozen.evidenceSha256)
    assert.equal(resolved.sourceEvidence, undefined)
  }
  current = { ...row, tokenCiphertext: encryptProviderSecret(settings.apiKey), mappings: [{ ...row.mappings[0], name: "只修改名称" }] }
  assert.deepEqual((await resolveGenerationProviderInTransaction(client, "mapping-a", 4)).annotationCapability, frozen)
  await assert.rejects(resolveGenerationProviderInTransaction(client, "mapping-a", 3), /模型配置已被其他管理员修改/)
  await assert.rejects(resolveGenerationProviderInTransaction(client, "removed", 4), /所选模型已被移除/)
})
