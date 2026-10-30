import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import { validateAnnotationExecution, AnnotationExecutionValidationError } from "../lib/annotation-execution"
import { serializeResolvedAnnotationCapabilityEvidence, type ResolvedAnnotationCapability } from "../lib/annotation-capability"

function execution() {
  const prefix = `image-playground/private/v1/${"a".repeat(64)}/${randomUUID()}/${randomUUID()}/inputs/`
  return { schema: 1, expression: "overlay-v1", renderVersion: 1, snapshotSha256: "b".repeat(64),
    original: { assetId: randomUUID(), sha256: "c".repeat(64), byteLength: 100, width: 80, height: 60, orientation: 6, pages: 1 },
    inputs: [
      { role: "original", id: randomUUID(), key: `${prefix}reference-1`, sha256: "c".repeat(64), byteLength: 100 },
      { role: "overlay", id: randomUUID(), key: `${prefix}reference-2`, sha256: "d".repeat(64), byteLength: 120 },
    ], capability: { expression: "overlay-v1", maxInputImages: 2, configurationRevision: 4, bindingSha256: "e".repeat(64), evidenceSha256: "f".repeat(64) },
  }
}
test("执行记录只接受有界纯数据，返回独立规范对象并固定两个输入角色", () => {
  const input = execution(), valid = validateAnnotationExecution(input)
  assert.deepEqual(valid, input)
  input.original.width = 40
  assert.equal(valid.original.width, 80)
  const mutations: Array<(value: ReturnType<typeof execution>) => void> = [
    value => { Object.assign(value, { apiKey: "forbidden" }) },
    value => { Object.assign(value.original, { ownerId: randomUUID() }) },
    value => { Object.assign(value.capability, { token: "forbidden" }) },
    value => { value.original.width = Infinity },
    value => { value.original.pages = 2 },
    value => { value.original.width = value.original.height = 8192 },
    value => { value.inputs[0].sha256 = "0".repeat(64) },
    value => { value.inputs[0].byteLength++ },
    value => { value.inputs[1].id = value.inputs[0].id },
    value => { value.inputs[1].key = value.inputs[0].key },
    value => { value.inputs[1].key = value.inputs[1].key.replace("private/v1", "releases") },
    value => { value.inputs[1].key += "?access=secret" },
    value => { value.inputs.reverse() },
    value => { value.capability.maxInputImages = 3 },
  ]
  for (const mutate of mutations) {
    const value = execution(); mutate(value)
    assert.throws(() => validateAnnotationExecution(value), AnnotationExecutionValidationError)
  }
})

test("execution保留完整来源证据，摘要校验拒绝被同时替换的证据正文", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const capability: ResolvedAnnotationCapability = { expression: "overlay-v1", maxInputImages: 2, configurationRevision: 4, bindingSha256: "e".repeat(64), evidenceSha256: "0".repeat(64),
    sourceEvidence: { mappingId: "mapping-a", evidence: { id: randomUUID(), actorId: "synthetic-admin", recordedAt: "2026-10-30T00:00:00.000Z", reference: "https://docs.example", note: "当前连接双图输入契约", confirmed: true } } }
  capability.evidenceSha256 = hash(serializeResolvedAnnotationCapabilityEvidence(capability)!)
  const input = { ...execution(), capability }
  const verification = { sha256: hash, mappingId: "mapping-a", configurationRevision: 4 }
  const accepted = validateAnnotationExecution(input, verification)
  assert.deepEqual(accepted.capability, capability)
  input.capability.sourceEvidence!.evidence.note = "被覆盖的来源"
  assert.notEqual(input.capability.sourceEvidence!.evidence.note, accepted.capability.sourceEvidence!.evidence.note)
  assert.throws(() => validateAnnotationExecution(input, verification), AnnotationExecutionValidationError)
})
