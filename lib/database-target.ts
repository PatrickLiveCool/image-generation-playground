import targets from "../deploy/database-targets.json" with { type: "json" }

export type DatabasePurpose = "runtime" | "migration"
export type DatabaseTarget = "local" | "production"

export class DatabaseBoundaryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "DatabaseBoundaryError"
    this.code = code
  }
}

export type DatabaseConfiguration = {
  purpose: DatabasePurpose
  target: DatabaseTarget
  host: string
  port: number
  database: string
  schema: string
  user: string
  password: string
}

function invalidConfiguration(): never {
  throw new DatabaseBoundaryError("DATABASE_CONFIGURATION", "数据库配置缺失或与固定目标清单不符。")
}

/** 不传 connectionString 给 pg，避免 URL 参数与 PG* 环境变量覆盖固定边界。 */
export function readDatabaseConfiguration(
  purpose: DatabasePurpose,
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfiguration {
  const target = environment.IMAGE_DATABASE_TARGET
  if (target !== "local" && target !== "production") invalidConfiguration()
  const endpoint = targets.targets[target]
  const raw = environment[purpose === "runtime" ? "IMAGE_DATABASE_URL" : "IMAGE_MIGRATION_DATABASE_URL"]
  if (!raw) invalidConfiguration()
  try {
    const url = new URL(raw)
    const user = decodeURIComponent(url.username)
    const password = decodeURIComponent(url.password)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.hostname !== endpoint.host || Number(url.port || 5432) !== endpoint.port ||
        url.pathname !== `/${targets.database}` || user !== targets.roles[purpose] ||
        !password || password.includes("\0") || url.search || url.hash) invalidConfiguration()
    return { purpose, target, ...endpoint, database: targets.database, schema: targets.schema, user, password }
  } catch {
    return invalidConfiguration()
  }
}

export type DatabaseInspectionClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

// 单一只读 SELECT。目标/身份/权限不合格时绝不发送 SET、DDL 或账本写入。
export const DATABASE_IDENTITY_SQL = `
SELECT current_database() AS database, current_user AS current_user,
       session_user AS session_user, current_schema() AS schema,
       current_setting('search_path') AS search_path,
       r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
       pg_get_userbyid(d.datdba) AS database_owner,
       pg_get_userbyid(n.nspowner) AS schema_owner,
       has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database_objects,
       has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp,
       has_schema_privilege(current_user, n.oid, 'USAGE') AS can_use_schema,
       has_schema_privilege(current_user, n.oid, 'CREATE') AS can_create_schema_objects,
       EXISTS (SELECT FROM pg_roles other WHERE other.rolname <> current_user
         AND NOT (other.rolname = 'pg_database_owner' AND current_user = pg_get_userbyid(d.datdba))
         AND pg_has_role(current_user, other.oid, 'MEMBER')) AS has_memberships,
       EXISTS (SELECT FROM pg_namespace other WHERE other.nspname <> $1
         AND other.nspname NOT LIKE 'pg_temp_%' AND other.nspname NOT LIKE 'pg_toast_temp_%'
         AND has_schema_privilege(current_user, other.oid, 'CREATE')) AS can_create_outside_schema,
       EXISTS (SELECT FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
         WHERE s.nspname NOT IN ($1, 'pg_catalog', 'information_schema')
         AND s.nspname NOT LIKE 'pg_toast%' AND s.nspname NOT LIKE 'pg_temp_%'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')) AS can_write_outside_schema,
       EXISTS (SELECT FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
         WHERE s.nspname NOT IN ($1, 'pg_catalog', 'information_schema')
         AND s.nspname NOT LIKE 'pg_toast%' AND s.nspname NOT LIKE 'pg_temp_%'
         AND c.relkind = 'S'
         AND has_sequence_privilege(current_user, c.oid, 'USAGE,UPDATE')) AS can_write_sequences_outside_schema,
       EXISTS (SELECT FROM pg_class c WHERE c.relnamespace = n.oid AND
         c.relkind IN ('r','p','v','m','S','f') AND c.relowner <> d.datdba) AS unexpected_object_owner,
       EXISTS (SELECT FROM pg_class c WHERE c.relnamespace = n.oid
         AND c.relkind IN ('r','p') AND c.relname <> 'schema_migrations'
         AND (NOT has_table_privilege($2, c.oid, 'SELECT')
           OR NOT has_table_privilege($2, c.oid, 'INSERT')
           OR NOT has_table_privilege($2, c.oid, 'UPDATE')
           OR NOT has_table_privilege($2, c.oid, 'DELETE')
           OR has_table_privilege($2, c.oid, 'TRUNCATE,REFERENCES,TRIGGER'))) AS runtime_table_permissions_invalid,
       EXISTS (SELECT FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind = 'S'
         AND (NOT has_sequence_privilege($2, c.oid, 'USAGE')
           OR has_sequence_privilege($2, c.oid, 'UPDATE'))) AS runtime_sequence_permissions_invalid,
       EXISTS (SELECT FROM pg_class c WHERE c.relnamespace = n.oid AND c.relname = 'schema_migrations'
         AND has_table_privilege($2, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS runtime_can_access_ledger
FROM pg_roles r JOIN pg_database d ON d.datname = current_database()
JOIN pg_namespace n ON n.nspname = $1
WHERE r.rolname = current_user`

export async function verifyDatabaseIdentity(
  client: DatabaseInspectionClient,
  configuration: DatabaseConfiguration,
): Promise<void> {
  let rows: Record<string, unknown>[]
  try {
    ;({ rows } = await client.query(DATABASE_IDENTITY_SQL, [targets.schema, targets.roles.runtime]))
  } catch {
    throw new DatabaseBoundaryError("DATABASE_IDENTITY", "数据库身份与权限核验失败。")
  }
  const row = rows[0]
  const migration = configuration.purpose === "migration"
  const safe = rows.length === 1 && row &&
    row.database === configuration.database && row.schema === configuration.schema &&
    row.current_user === configuration.user && row.session_user === configuration.user &&
    typeof row.search_path === "string" && row.search_path.replaceAll(" ", "") === "app,pg_catalog" &&
    row.database_owner === targets.roles.migration && row.schema_owner === targets.roles.migration &&
    row.can_connect === true && row.can_use_schema === true &&
    row.can_create_database_objects === migration && row.can_temp === migration &&
    row.can_create_schema_objects === migration &&
    ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "has_memberships",
      "can_create_outside_schema", "can_write_outside_schema", "can_write_sequences_outside_schema", "unexpected_object_owner",
      "runtime_table_permissions_invalid", "runtime_sequence_permissions_invalid", "runtime_can_access_ledger"]
      .every((flag) => row[flag] === false)
  if (!safe) throw new DatabaseBoundaryError("DATABASE_BOUNDARY", "数据库目标、身份或有效权限不符合项目边界。")
}
