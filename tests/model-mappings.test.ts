import { strict as assert } from "node:assert"
import { test } from "node:test"
// @ts-expect-error Node's built-in TypeScript runner requires the file extension.
import { normalizeModelMappings, validateModelMappings, restoreModelMappings, resolveModelMapping } from "../lib/model-mappings.ts"

const mappings = [
  { id: "premium", name: "极致", modelId: "upstream-image-a" },
  { id: "balanced", name: "均衡", modelId: "upstream-image-b" },
]

test("renaming and sorting retain the selected mapping and actual requested model", () => {
  const edited = [{ ...mappings[1] }, { ...mappings[0], name: "作品级" }]
  assert.equal(resolveModelMapping(edited, "premium")?.modelId, "upstream-image-a")
  assert.equal(resolveModelMapping(edited, "premium")?.name, "作品级")
})

test("remapping uses the new model; deleted selections never fall back to another model", () => {
  assert.equal(resolveModelMapping([{ ...mappings[0], modelId: "new-model" }], "premium")?.modelId, "new-model")
  assert.equal(resolveModelMapping([mappings[1]], "premium"), undefined)
  assert.equal(resolveModelMapping(mappings, "upstream-image-a"), undefined)
})

test("restoring mappings preserves custom names, order and IDs without inventing defaults", () => {
  assert.deepEqual(restoreModelMappings(JSON.parse(JSON.stringify(mappings))), mappings)
  assert.deepEqual(restoreModelMappings(undefined), [])
  assert.deepEqual(restoreModelMappings([{ name: "broken" }]), [])
})

test("invalid or ambiguous names and incomplete model bindings cannot be saved", () => {
  assert.match(validateModelMappings([{ ...mappings[0], name: " " }])!, /显示名称/)
  assert.match(validateModelMappings([{ ...mappings[0], modelId: " " }])!, /实际模型/)
  assert.match(validateModelMappings([mappings[0], { ...mappings[1], name: " 极致 " }])!, /重复/)
  assert.match(validateModelMappings([mappings[0], { ...mappings[1], id: "premium" }])!, /标识/)
  assert.equal(validateModelMappings([{ ...mappings[0], name: "Fast" }, { ...mappings[1], name: "ＦＡＳＴ" }])?.includes("重复"), true)
})

test("custom names and multiple aliases for one model remain flexible", () => {
  const custom = [{ ...mappings[0], name: "  海报  ", modelId: "  custom-alias  " }, { ...mappings[1], name: "草稿", modelId: "custom-alias" }]
  assert.equal(validateModelMappings(custom), null)
  const normalized = normalizeModelMappings(custom)
  assert.equal(normalized[0].name, "海报")
  assert.equal(normalized[0].modelId, "custom-alias")
  assert.equal(custom[0].name, "  海报  ")
})
