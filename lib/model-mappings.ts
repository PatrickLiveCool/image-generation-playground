import type { ModelMapping } from "./api-provider-types"

export function normalizeModelMappings(mappings: ModelMapping[]): ModelMapping[] {
  return mappings.map(mapping => ({ id: mapping.id, name: mapping.name.trim(), modelId: mapping.modelId.trim() }))
}

export function validateModelMappings(mappings: ModelMapping[]): string | null {
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const [index, mapping] of mappings.entries()) {
    const prefix = `第 ${index + 1} 条映射：`
    if (!mapping.id || ids.has(mapping.id)) return `${prefix}记录标识无效，请删除后重新添加。`
    ids.add(mapping.id)
    const name = mapping.name.trim()
    if (!name) return `${prefix}请填写显示名称。`
    if (name.length > 40 || /[\r\n]/.test(name)) return `${prefix}显示名称最多 40 字，不能包含换行。`
    const uniqueName = name.normalize("NFKC").toLowerCase()
    if (names.has(uniqueName)) return `${prefix}显示名称重复，请使用不同名称。`
    names.add(uniqueName)
    if (!mapping.modelId.trim() || mapping.modelId.trim().length > 256 || /[\r\n]/.test(mapping.modelId)) {
      return `${prefix}请选择或填写有效的实际模型 ID。`
    }
  }
  return null
}

/** Older saved connections have no mapping. Do not invent aliases or bindings. */
export function restoreModelMappings(value: unknown): ModelMapping[] {
  if (!Array.isArray(value)) return []
  if (!value.every(mapping => mapping && typeof mapping.id === "string" && typeof mapping.name === "string" && typeof mapping.modelId === "string")) return []
  const normalized = normalizeModelMappings(value)
  return validateModelMappings(normalized) ? [] : normalized
}

/** Selection follows the mapping's stable identity through renames and reordering. */
export function resolveModelMapping<T extends { id: string }>(mappings: readonly T[], selectedId: string): T | undefined {
  return mappings.find(mapping => mapping.id === selectedId)
}
