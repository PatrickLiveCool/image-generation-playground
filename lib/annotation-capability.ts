/** Shared shape validation only: safe to include in browser and maintenance bundles. */
export type ResolvedAnnotationCapability = {
  expression: "overlay-v1"
  /** Legacy field name: the original/overlay pair, not the provider image limit. */
  maxInputImages: 2
  configurationRevision: number
  bindingSha256: string
  /** Legacy field name; default runs store the built-in input-policy digest here. */
  evidenceSha256: string
  /** Historical administrator evidence, retained only on previously admitted runs. */
  sourceEvidence?: { mappingId: string; evidence: AnnotationEvidence }
}

export type AnnotationEvidence = {
  id: string
  actorId: string
  recordedAt: string
  reference: string
  note: string
  confirmed: true
}

export type StoredAnnotationCapability = Omit<ResolvedAnnotationCapability, "sourceEvidence"> & {
  mappingId: string
  evidence: AnnotationEvidence
}

export type PublicAnnotationCapability = {
  available: boolean
  expression: "overlay-v1" | null
  /** Retained wire field for old clients; describes the annotation pair, not provider capacity. */
  maxInputImages: 2
  reason: string | null
}

export type AnnotationCapabilityVerification = {
  sha256: (value: string) => string
  mappingId?: string
  configurationRevision?: number
}

export class AnnotationCapabilityValidationError extends Error {
  constructor(message = "批注能力记录格式无效。") { super(message); this.name = "AnnotationCapabilityValidationError" }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new AnnotationCapabilityValidationError()
  return value as Record<string, unknown>
}

function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) throw new AnnotationCapabilityValidationError()
  return value
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) throw new AnnotationCapabilityValidationError()
  return value as number
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new AnnotationCapabilityValidationError()
  return value
}

function reference(value: unknown): string {
  const input = text(value, 2048)
  try {
    const url = new URL(input)
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error()
    return input
  } catch { throw new AnnotationCapabilityValidationError("请填写不含账号密码的 HTTPS 证据来源链接。") }
}

const resolvedKeys = ["expression", "maxInputImages", "configurationRevision", "bindingSha256", "evidenceSha256"]
export function validateResolvedAnnotationCapability(value: unknown, verification?: AnnotationCapabilityVerification): ResolvedAnnotationCapability {
  const hasSource = !!value && typeof value === "object" && Object.hasOwn(value, "sourceEvidence")
  const input = object(value, [...resolvedKeys, ...(hasSource ? ["sourceEvidence"] : [])])
  if (input.expression !== "overlay-v1" || input.maxInputImages !== 2) throw new AnnotationCapabilityValidationError()
  const result: ResolvedAnnotationCapability = { expression: "overlay-v1", maxInputImages: 2, configurationRevision: revision(input.configurationRevision), bindingSha256: sha256(input.bindingSha256), evidenceSha256: sha256(input.evidenceSha256) }
  if (hasSource) {
    const source = object(input.sourceEvidence, ["mappingId", "evidence"])
    result.sourceEvidence = { mappingId: text(source.mappingId, 128), evidence: validateAnnotationEvidence(source.evidence) }
  }
  if (verification && ((verification.configurationRevision !== undefined && verification.configurationRevision !== result.configurationRevision)
    || (result.sourceEvidence && ((verification.mappingId !== undefined && verification.mappingId !== result.sourceEvidence.mappingId)
      || verification.sha256(serializeSourceEvidence(result.bindingSha256, result.sourceEvidence)) !== result.evidenceSha256)))) throw new AnnotationCapabilityValidationError("批注来源证据与已冻结能力不匹配。")
  return result
}

function validateAnnotationEvidence(value: unknown): AnnotationEvidence {
  const evidence = object(value, ["id", "actorId", "recordedAt", "reference", "note", "confirmed"])
  if (typeof evidence.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(evidence.id)
    || typeof evidence.recordedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(evidence.recordedAt)
    || !Number.isFinite(Date.parse(evidence.recordedAt)) || new Date(evidence.recordedAt).toISOString() !== evidence.recordedAt || evidence.confirmed !== true) throw new AnnotationCapabilityValidationError()
  return {
    id: evidence.id, actorId: text(evidence.actorId, 256), recordedAt: evidence.recordedAt,
    reference: reference(evidence.reference), note: text(evidence.note, 2000, true), confirmed: true,
  }
}

export function validateStoredAnnotationCapability(value: unknown): StoredAnnotationCapability {
  const input = object(value, [...resolvedKeys, "mappingId", "evidence"])
  const resolved = validateResolvedAnnotationCapability(Object.fromEntries(resolvedKeys.map(key => [key, input[key]])))
  return { ...resolved, mappingId: text(input.mappingId, 128), evidence: validateAnnotationEvidence(input.evidence) }
}

export function validateAnnotationCapabilities(value: unknown): StoredAnnotationCapability[] {
  if (!Array.isArray(value) || value.length > 100) throw new AnnotationCapabilityValidationError()
  const result = value.map(validateStoredAnnotationCapability)
  if (new Set(result.map(item => item.mappingId)).size !== result.length || new Set(result.map(item => item.evidence.id)).size !== result.length) throw new AnnotationCapabilityValidationError()
  return result
}

/** Fixed serialization lets server and backup validation check the same evidence digest. */
export function serializeAnnotationCapabilityEvidence(value: StoredAnnotationCapability): string {
  const { mappingId, bindingSha256, evidence } = validateStoredAnnotationCapability(value)
  return serializeSourceEvidence(bindingSha256, { mappingId, evidence })
}

function serializeSourceEvidence(bindingSha256: string, source: NonNullable<ResolvedAnnotationCapability["sourceEvidence"]>): string {
  return JSON.stringify({ schema: 1, mappingId: source.mappingId, bindingSha256, evidence: source.evidence })
}

/** Null denotes a five-field snapshot: an application-default run or a legacy run without frozen evidence. */
export function serializeResolvedAnnotationCapabilityEvidence(value: ResolvedAnnotationCapability): string | null {
  const capability = validateResolvedAnnotationCapability(value)
  return capability.sourceEvidence ? serializeSourceEvidence(capability.bindingSha256, capability.sourceEvidence) : null
}

export function serializeAnnotationCapabilityBinding(value: { baseUrl: string; apiMode: "images" | "chat"; modelId: string; tokenSha256: string }): string {
  if (value.apiMode !== "images" && value.apiMode !== "chat") throw new AnnotationCapabilityValidationError()
  return JSON.stringify({ schema: 1, baseUrl: text(value.baseUrl, 2048), apiMode: value.apiMode, modelId: text(value.modelId, 256), tokenSha256: sha256(value.tokenSha256) })
}

/** Fixed application behavior, not an assertion of provider support or administrator verification. */
export function serializeDefaultAnnotationPolicy(bindingSha256: string): string {
  return JSON.stringify({ schema: 1, source: "application-default", expression: "overlay-v1",
    inputs: ["original", "overlay"], bindingSha256: sha256(bindingSha256) })
}

/** Preserve the existing five-field snapshot so earlier readers and backups remain compatible. */
export function createDefaultAnnotationCapability(configurationRevision: number, bindingSha256: string, hash: (value: string) => string): ResolvedAnnotationCapability {
  return validateResolvedAnnotationCapability({ expression: "overlay-v1", maxInputImages: 2,
    configurationRevision, bindingSha256, evidenceSha256: hash(serializeDefaultAnnotationPolicy(bindingSha256)) })
}

export function validatePublicAnnotationCapability(value: unknown): PublicAnnotationCapability {
  const input = object(value, ["available", "expression", "maxInputImages", "reason"])
  if (input.maxInputImages !== 2) throw new AnnotationCapabilityValidationError()
  if (input.available === true && input.expression === "overlay-v1" && input.reason === null) return { available: true, expression: "overlay-v1", maxInputImages: 2, reason: null }
  if (input.available === false && input.expression === null) return { available: false, expression: null, maxInputImages: 2, reason: text(input.reason, 300) }
  throw new AnnotationCapabilityValidationError()
}

export function publicAnnotationCapability(capability: ResolvedAnnotationCapability | null): PublicAnnotationCapability {
  if (capability) { validateResolvedAnnotationCapability(capability); return { available: true, expression: "overlay-v1", maxInputImages: 2, reason: null } }
  return { available: false, expression: null, maxInputImages: 2, reason: "当前模型配置不可用，请刷新模型列表。" }
}
