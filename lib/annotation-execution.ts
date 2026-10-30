import { validateResolvedAnnotationCapability, type AnnotationCapabilityVerification, type ResolvedAnnotationCapability } from "./annotation-capability"

export type AnnotationExecutionInput = { role: "original" | "overlay"; id: string; key: string; sha256: string; byteLength: number }
export type AnnotationExecution = {
  schema: 1; expression: "overlay-v1"; renderVersion: 1; snapshotSha256: string
  original: { assetId: string; sha256: string; byteLength: number; width: number; height: number; orientation: number; pages: 1 }
  inputs: [AnnotationExecutionInput & { role: "original" }, AnnotationExecutionInput & { role: "overlay" }]
  capability: ResolvedAnnotationCapability
}
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const UUID = new RegExp(`^${UUID_SOURCE}$`)
const INPUT_KEY = new RegExp(`^(image-playground/private/v1/[0-9a-f]{64}/${UUID_SOURCE}/${UUID_SOURCE})/inputs/reference-([12])$`)
const HASH = /^[0-9a-f]{64}$/
export class AnnotationExecutionValidationError extends Error {
  constructor() { super("批注执行记录无效。"); this.name = "AnnotationExecutionValidationError" }
}
function fail(): never { throw new AnnotationExecutionValidationError() }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail()
  return value as Record<string, unknown>
}
function string(value: unknown, pattern: RegExp): string { if (typeof value !== "string" || !pattern.test(value)) fail(); return value }
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(); return value as number }

/** 纯形状验证，不读取配置、资产或环境；备份与修复共享同一有界白名单。 */
export function validateAnnotationExecution(value: unknown, verification?: AnnotationCapabilityVerification): AnnotationExecution {
  const item = exact(value, ["schema", "expression", "renderVersion", "snapshotSha256", "original", "inputs", "capability"])
  if (item.schema !== 1 || item.expression !== "overlay-v1" || item.renderVersion !== 1) fail()
  const source = exact(item.original, ["assetId", "sha256", "byteLength", "width", "height", "orientation", "pages"])
  if (source.pages !== 1) fail()
  const original: AnnotationExecution["original"] = {
    assetId: string(source.assetId, UUID), sha256: string(source.sha256, HASH), byteLength: integer(source.byteLength, 1, 20 * 1024 * 1024),
    width: integer(source.width, 1, 16384), height: integer(source.height, 1, 16384), orientation: integer(source.orientation, 1, 8), pages: 1,
  }
  if (original.width * original.height > 16_777_216 || !Array.isArray(item.inputs) || item.inputs.length !== 2) fail()
  const inputs = item.inputs.map((raw, index) => {
    const input = exact(raw, ["role", "id", "key", "sha256", "byteLength"])
    if (input.role !== (index === 0 ? "original" : "overlay")) fail()
    const key = string(input.key, INPUT_KEY)
    if (!key.endsWith(`/reference-${index + 1}`)) fail()
    return { role: input.role, id: string(input.id, UUID), key, sha256: string(input.sha256, HASH), byteLength: integer(input.byteLength, 1, 20 * 1024 * 1024) }
  }) as AnnotationExecution["inputs"]
  if (inputs[0].id === inputs[1].id || inputs.some(input => input.id === original.assetId) ||
      inputs[0].key.slice(0, -1) !== inputs[1].key.slice(0, -1) || inputs[0].sha256 !== original.sha256 || inputs[0].byteLength !== original.byteLength) fail()
  let capability: ResolvedAnnotationCapability
  try { capability = validateResolvedAnnotationCapability(item.capability, verification) } catch { fail() }
  return { schema: 1, expression: "overlay-v1", renderVersion: 1, snapshotSha256: string(item.snapshotSha256, HASH), original, inputs, capability }
}
