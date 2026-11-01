import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseBoundaryError } from "../lib/database-target"
import { PHYSICAL_COLUMNS_SQL, PHYSICAL_CONSTRAINTS_SQL, PHYSICAL_TABLES_SQL, PROJECT_PHYSICAL_SCHEMA, verifyProjectPhysicalSchema } from "../scripts/database/schema-contract"

function fixture() {
  const metadata = structuredClone(PROJECT_PHYSICAL_SCHEMA)
  const statements: string[] = []
  return { metadata, statements, client: { query: async (sql: string) => {
    statements.push(sql)
    assert.match(sql, /^SELECT /, "schema validation must be read-only")
    if (sql === PHYSICAL_TABLES_SQL) return { rows: metadata.tables }
    if (sql === PHYSICAL_COLUMNS_SQL) return { rows: metadata.columns }
    if (sql === PHYSICAL_CONSTRAINTS_SQL) return { rows: metadata.constraints }
    throw new Error("unexpected query")
  } } }
}
const mismatch = (error: unknown) => error instanceof DatabaseBoundaryError && error.code === "BACKUP_SCHEMA_MISMATCH"

test("physical contract covers all 13 tables including auth ephemeral tables and the ledger using only catalog reads", async () => {
  const f = fixture()
  assert.deepEqual(f.metadata.tables.map(row => row.table_name).sort(), ["schema_migrations", "user", "session", "account", "verification", "rateLimit",
    "account_audit", "provider_settings", "provider_config_audit", "provider_request_slots", "creations", "generation_runs", "private_assets"].sort())
  assert.deepEqual(f.metadata.columns.filter(row => row.table_name === "session").map(row => row.column_name),
    ["id", "expiresAt", "token", "createdAt", "updatedAt", "ipAddress", "userAgent", "userId", "impersonatedBy"])
  assert.equal(f.metadata.constraints.filter(row => row.constraint_type === "p").length, 13)
  assert.equal(f.metadata.constraints.filter(row => row.constraint_type === "u").length, 12)
  assert.equal(f.metadata.constraints.filter(row => row.constraint_type === "f").length, 12)
  // PostgreSQL physical column/constraint order and constraint names need not match creation order.
  f.metadata.columns.reverse(); f.metadata.constraints.reverse(); f.metadata.tables.reverse()
  await verifyProjectPhysicalSchema(f.client)
  assert.deepEqual(f.statements, [PHYSICAL_TABLES_SQL, PHYSICAL_COLUMNS_SQL, PHYSICAL_CONSTRAINTS_SQL])
})

test("missing session.token, verification.value or rateLimit.lastRequest can never pass the physical oracle", async () => {
  for (const [table, column] of [["session", "token"], ["verification", "value"], ["rateLimit", "lastRequest"], ["schema_migrations", "sha256"],
    ["provider_settings", "annotationCapabilities"], ["generation_runs", "annotationSnapshot"], ["generation_runs", "annotationExecution"], ["generation_runs", "providerAnnotationCapability"]]) {
    const f = fixture()
    f.metadata.columns = f.metadata.columns.filter(row => row.table_name !== table || row.column_name !== column)
    await assert.rejects(verifyProjectPhysicalSchema(f.client), mismatch)
    assert.equal(f.statements.length, 2)
  }
})

test("wrong scalar types, nullability, identity and same-named nonbuiltin types fail before accepting a database", async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.metadata.columns.find(row => row.table_name === "user" && row.column_name === "banned")!.data_type = "text" },
    f => { f.metadata.columns.find(row => row.table_name === "session" && row.column_name === "expiresAt")!.data_type = "timestamp without time zone" },
    f => { f.metadata.columns.find(row => row.table_name === "provider_settings" && row.column_name === "models")!.data_type = "json" },
    f => { f.metadata.columns.find(row => row.table_name === "session" && row.column_name === "token")!.not_null = false },
    f => { f.metadata.columns.find(row => row.table_name === "account_audit" && row.column_name === "id")!.identity_kind = "" },
    f => { f.metadata.columns.find(row => row.table_name === "user" && row.column_name === "id")!.type_schema = "app" },
    f => { f.metadata.columns.find(row => row.column_name === "annotationCapabilities")!.not_null = false },
    f => { f.metadata.columns.find(row => row.column_name === "annotationSnapshot")!.not_null = true },
    f => { f.metadata.columns.find(row => row.column_name === "annotationExecution")!.data_type = "text" },
  ]
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(verifyProjectPhysicalSchema(f.client), mismatch) }
})

test("missing or weakened primary, unique and owner-scoped foreign constraints fail even when all columns match", async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    ...["p", "u", "f"].map(type => (f: ReturnType<typeof fixture>) => { f.metadata.constraints.splice(f.metadata.constraints.findIndex(row => row.constraint_type === type), 1) }),
    f => { f.metadata.constraints.find(row => row.table_name === "private_assets" && row.constraint_type === "f")!.column_names = ["runId"] },
    f => { f.metadata.constraints.find(row => row.table_name === "private_assets" && row.constraint_type === "f")!.foreign_column_names = ["creationId", "ownerId", "id"] },
    f => { f.metadata.constraints.find(row => row.constraint_type === "f")!.foreign_schema = "public" },
    f => { f.metadata.constraints.find(row => row.constraint_type === "f")!.foreign_table = "account" },
    f => { f.metadata.constraints.find(row => row.table_name === "session" && row.constraint_type === "f")!.on_delete = "a" },
    f => { f.metadata.constraints.find(row => row.constraint_type === "f")!.is_validated = false },
    f => { f.metadata.constraints.find(row => row.constraint_type === "f")!.is_deferrable = true },
    f => { f.metadata.constraints.find(row => row.constraint_type === "u")!.index_valid = false },
    f => { f.metadata.constraints.find(row => row.constraint_type === "p")!.index_ready = false },
  ]
  for (const change of changes) {
    const f = fixture(); change(f)
    await assert.rejects(verifyProjectPhysicalSchema(f.client), mismatch)
    assert.equal(f.statements.length, 3)
  }
})

test("unexpected objects, duplicate metadata, generated columns and row policies are rejected safely", async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.metadata.tables.pop() },
    f => { f.metadata.tables.push({ ...f.metadata.tables[0], table_name: "unreviewed_table" }) },
    f => { f.metadata.tables[0].table_kind = "v" },
    f => { f.metadata.tables[0].row_security = true },
    f => { f.metadata.columns.push({ ...f.metadata.columns[0] }) },
    f => { f.metadata.columns[0].generated_kind = "s" },
    f => { f.metadata.constraints.push({ ...f.metadata.constraints[0] }) },
  ]
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(verifyProjectPhysicalSchema(f.client), mismatch) }
  await assert.rejects(verifyProjectPhysicalSchema({ query: async () => { throw new Error("private raw database diagnostic") } }), error => {
    assert.equal(mismatch(error), true)
    assert.doesNotMatch((error as Error).message, /private raw/)
    return true
  })
})
