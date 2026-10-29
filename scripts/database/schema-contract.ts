import { DatabaseBoundaryError, type DatabaseInspectionClient } from "../../lib/database-target"

type Row = Record<string, unknown>
type Column = readonly [name: string, type: string, nullable?: boolean, identity?: "a"]
type Table = { columns: readonly Column[]; primary: readonly string[]; unique?: readonly (readonly string[])[]; foreign?: readonly ForeignKey[] }
type ForeignKey = readonly [columns: readonly string[], target: string, targetColumns: readonly string[], onDelete?: "c"]
const timestamp = "timestamp with time zone"

// 固定来自已审核且不可改写的0001—0004，另含迁移运行器拥有的账本。
// 不从数据库、归档、环境或SQL目录推导“应有”结构；新增迁移须同步人工审核此契约。
const tables: Readonly<Record<string, Table>> = {
  schema_migrations: { columns: [["version", "text"], ["name", "text"], ["sha256", "text"], ["applied_at", timestamp]], primary: ["version"], unique: [["name"]] },
  user: { columns: [["id", "text"], ["name", "text"], ["email", "text"], ["emailVerified", "boolean"], ["image", "text", true],
    ["createdAt", timestamp], ["updatedAt", timestamp], ["username", "text"], ["displayUsername", "text", true], ["role", "text"],
    ["banned", "boolean"], ["banReason", "text", true], ["banExpires", timestamp, true], ["mustChangePassword", "boolean"],
    ["temporaryPasswordExpiresAt", timestamp, true], ["temporaryPasswordUsedAt", timestamp, true]], primary: ["id"], unique: [["email"], ["username"]] },
  session: { columns: [["id", "text"], ["expiresAt", timestamp], ["token", "text"], ["createdAt", timestamp], ["updatedAt", timestamp],
    ["ipAddress", "text", true], ["userAgent", "text", true], ["userId", "text"], ["impersonatedBy", "text", true]],
    primary: ["id"], unique: [["token"]], foreign: [[["userId"], "user", ["id"], "c"]] },
  account: { columns: [["id", "text"], ["accountId", "text"], ["providerId", "text"], ["userId", "text"], ["accessToken", "text", true],
    ["refreshToken", "text", true], ["idToken", "text", true], ["accessTokenExpiresAt", timestamp, true], ["refreshTokenExpiresAt", timestamp, true],
    ["scope", "text", true], ["password", "text", true], ["createdAt", timestamp], ["updatedAt", timestamp]], primary: ["id"],
    unique: [["providerId", "accountId"], ["userId", "providerId"]], foreign: [[["userId"], "user", ["id"], "c"]] },
  verification: { columns: [["id", "text"], ["identifier", "text"], ["value", "text"], ["expiresAt", timestamp], ["createdAt", timestamp], ["updatedAt", timestamp]], primary: ["id"] },
  rateLimit: { columns: [["id", "text"], ["key", "text"], ["count", "integer"], ["lastRequest", "bigint"]], primary: ["id"], unique: [["key"]] },
  account_audit: { columns: [["id", "bigint", false, "a"], ["actorId", "text"], ["subjectId", "text"], ["action", "text"], ["createdAt", timestamp]],
    primary: ["id"], foreign: [[["actorId"], "user", ["id"]], [["subjectId"], "user", ["id"]]] },
  provider_settings: { columns: [["singleton", "smallint"], ["baseUrl", "text"], ["tokenCiphertext", "text"], ["apiMode", "text"], ["models", "jsonb"],
    ["mappings", "jsonb"], ["modelsSynced", "boolean"], ["revision", "integer"], ["updatedBy", "text"], ["updatedAt", timestamp]],
    primary: ["singleton"], foreign: [[["updatedBy"], "user", ["id"]]] },
  provider_config_audit: { columns: [["id", "bigint", false, "a"], ["actorId", "text"], ["revision", "integer"], ["action", "text"], ["createdAt", timestamp]],
    primary: ["id"], foreign: [[["actorId"], "user", ["id"]]] },
  provider_request_slots: { columns: [["userId", "text"], ["requestId", "uuid"], ["fingerprint", "text"], ["status", "text"], ["acceptedAt", timestamp], ["deadlineAt", timestamp]],
    primary: ["userId", "requestId"], foreign: [[["userId"], "user", ["id"], "c"]] },
  creations: { columns: [["ownerId", "text"], ["id", "uuid"], ["title", "text"], ["revision", "integer"], ["nextVersion", "integer"], ["createdAt", timestamp], ["updatedAt", timestamp]],
    primary: ["ownerId", "id"], foreign: [[["ownerId"], "user", ["id"], "c"]] },
  generation_runs: { columns: [["ownerId", "text"], ["id", "uuid"], ["creationId", "uuid"], ["clientRequestId", "uuid"], ["fingerprint", "text"],
    ["version", "integer"], ["parentVersionId", "uuid", true], ["status", "text"], ["prompt", "text"], ["mappingId", "text"], ["modelLabel", "text"],
    ["aspectRatio", "text"], ["quality", "text"], ["mode", "text"], ["providerBaseUrl", "text"], ["providerApiMode", "text"], ["providerModelId", "text"],
    ["providerRevision", "integer"], ["manifestKey", "text"], ["outputKey", "text"], ["outputAssetId", "uuid"], ["failureCode", "text", true],
    ["createdAt", timestamp], ["updatedAt", timestamp], ["deadlineAt", timestamp]], primary: ["ownerId", "id"],
    unique: [["ownerId", "clientRequestId"], ["ownerId", "creationId", "id"], ["ownerId", "creationId", "version"], ["ownerId", "outputAssetId"]],
    foreign: [[["ownerId", "creationId"], "creations", ["ownerId", "id"], "c"],
      [["ownerId", "creationId", "parentVersionId"], "generation_runs", ["ownerId", "creationId", "id"]],
      [["ownerId", "clientRequestId"], "provider_request_slots", ["userId", "requestId"], "c"]] },
  private_assets: { columns: [["ownerId", "text"], ["id", "uuid"], ["creationId", "uuid"], ["runId", "uuid"], ["key", "text"], ["kind", "text"],
    ["mediaType", "text"], ["byteLength", "integer"], ["sha256", "text"], ["name", "text", true], ["createdAt", timestamp]],
    primary: ["ownerId", "id"], unique: [["key"]], foreign: [[["ownerId", "creationId", "runId"], "generation_runs", ["ownerId", "creationId", "id"], "c"]] },
}

export const PHYSICAL_TABLES_SQL = `SELECT c.relname AS table_name, c.relkind::text AS table_kind,
  c.relpersistence::text AS persistence, c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'app' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`
export const PHYSICAL_COLUMNS_SQL = `SELECT c.relname AS table_name, a.attname AS column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, tn.nspname AS type_schema, a.attnotnull AS not_null,
  a.attidentity::text AS identity_kind, a.attgenerated::text AS generated_kind
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
WHERE n.nspname = 'app' AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum`
export const PHYSICAL_CONSTRAINTS_SQL = `SELECT t.relname AS table_name, c.contype::text AS constraint_type,
  ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY k(attribute_number, key_position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attribute_number ORDER BY k.key_position) AS column_names,
  CASE WHEN c.contype = 'f' THEN fn.nspname::text END AS foreign_schema,
  CASE WHEN c.contype = 'f' THEN ft.relname::text END AS foreign_table,
  CASE WHEN c.contype = 'f' THEN ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY k(attribute_number, key_position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attribute_number ORDER BY k.key_position) END AS foreign_column_names,
  CASE WHEN c.contype = 'f' THEN c.confupdtype::text END AS on_update,
  CASE WHEN c.contype = 'f' THEN c.confdeltype::text END AS on_delete,
  CASE WHEN c.contype = 'f' THEN c.confmatchtype::text END AS match_type,
  c.convalidated AS is_validated, c.condeferrable AS is_deferrable, c.condeferred AS is_deferred,
  i.indisvalid AS index_valid, i.indisready AS index_ready, i.indisunique AS index_unique
FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
LEFT JOIN pg_catalog.pg_class ft ON ft.oid = c.confrelid
LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = ft.relnamespace
LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.conindid
WHERE n.nspname = 'app' AND c.contype IN ('p','u','f') ORDER BY t.relname, c.conname`

function constraint(table: string, type: "p" | "u" | "f", columns: readonly string[], foreign?: ForeignKey): Row {
  return { table_name: table, constraint_type: type, column_names: [...columns], foreign_schema: foreign ? "app" : null,
    foreign_table: foreign?.[1] ?? null, foreign_column_names: foreign ? [...foreign[2]] : null,
    on_update: foreign ? "a" : null, on_delete: foreign ? foreign[3] ?? "a" : null, match_type: foreign ? "s" : null,
    is_validated: true, is_deferrable: false, is_deferred: false, index_valid: true, index_ready: true, index_unique: true }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
// 可由离线测试读取的固定元数据；运行时不可由调用者覆写。
export const PROJECT_PHYSICAL_SCHEMA = freeze({
  tables: Object.keys(tables).map(table => ({ table_name: table, table_kind: "r", persistence: "p", row_security: false, force_row_security: false })),
  columns: Object.entries(tables).flatMap(([table, definition]) => definition.columns.map(([name, type, nullable, identity]) =>
    ({ table_name: table, column_name: name, data_type: type, type_schema: "pg_catalog", not_null: !nullable, identity_kind: identity ?? "", generated_kind: "" }))),
  constraints: Object.entries(tables).flatMap(([table, definition]) => [constraint(table, "p", definition.primary),
    ...(definition.unique ?? []).map(columns => constraint(table, "u", columns)),
    ...(definition.foreign ?? []).map(foreign => constraint(table, "f", foreign[0], foreign))]),
})
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(",")}}`
  return JSON.stringify(value)
}
function sameRows(actual: Row[], expected: readonly Row[]): boolean {
  return actual.length === expected.length && actual.map(canonical).sort().join("\n") === expected.map(canonical).sort().join("\n")
}

/** 仅查询系统目录；检查完整表/列集合、类型与空值边界、identity以及所有主键/唯一键/外键。 */
export async function verifyProjectPhysicalSchema(client: DatabaseInspectionClient): Promise<void> {
  try {
    for (const [sql, expected] of [[PHYSICAL_TABLES_SQL, PROJECT_PHYSICAL_SCHEMA.tables],
      [PHYSICAL_COLUMNS_SQL, PROJECT_PHYSICAL_SCHEMA.columns], [PHYSICAL_CONSTRAINTS_SQL, PROJECT_PHYSICAL_SCHEMA.constraints]] as const) {
      if (!sameRows((await client.query(sql)).rows, expected)) throw new Error("schema contract mismatch")
    }
  } catch { throw new DatabaseBoundaryError("BACKUP_SCHEMA_MISMATCH", "项目物理表、列或关系约束不符合固定迁移契约。") }
}
