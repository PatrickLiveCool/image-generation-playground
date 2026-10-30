import assert from "node:assert/strict"
import { test } from "node:test"
import { DATABASE_IDENTITY_SQL, DatabaseBoundaryError, type DatabasePurpose } from "../lib/database-target"
import { encryptProviderSecret } from "../lib/provider-secret"
import { loadMigrations, MIGRATION_LEDGER_EXISTS_SQL, MIGRATION_LEDGER_SQL, type MigrationLedgerEntry } from "../scripts/database/migrate"
import { maintenanceDatabaseContract, maintenanceError, runMaintenance, validateMaintenanceRelease, type MaintenanceDependencies } from "../scripts/database/maintenance"

const environment = {
  NODE_ENV: "test" as const, IMAGE_DATABASE_TARGET: "local",
  IMAGE_DATABASE_URL: "postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image",
  IMAGE_MIGRATION_DATABASE_URL: "postgresql://qintopia_image_migrator:synthetic-local-migrator-only@127.0.0.1:32768/qintopia_image",
  BETTER_AUTH_URL: "http://localhost:3108", BETTER_AUTH_SECRET: "synthetic-maintenance-auth-secret-only",
  PROVIDER_CONFIG_KEY: Buffer.alloc(32, 31).toString("base64"),
}
const release = () => ({ schema: 2, application: "qintopia-image", version: "v0.3.0", revision: "a".repeat(40), platform: "linux/amd64",
  builtAt: "2026-10-30T00:00:00.123456Z", browserWorkspaceSchema: 2, assetCapabilityVersion: 1,
  databaseMode: "postgresql", assetAccessProtocol: "account-private-v1", database: maintenanceDatabaseContract() })

function identity(purpose: DatabasePurpose) {
  const migration = purpose === "migration", user = migration ? "qintopia_image_migrator" : "qintopia_image_app"
  return { database: "qintopia_image", current_user: user, session_user: user, schema: "app", search_path: "app, pg_catalog",
    database_owner: "qintopia_image_migrator", schema_owner: "qintopia_image_migrator", can_connect: true, can_use_schema: true,
    can_create_database_objects: migration, can_temp: migration, can_create_schema_objects: migration,
    rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, has_memberships: false,
    can_create_outside_schema: false, can_write_outside_schema: false, can_write_sequences_outside_schema: false,
    unexpected_object_owner: false, runtime_table_permissions_invalid: false, runtime_sequence_permissions_invalid: false, runtime_can_access_ledger: false }
}
async function fixture(prefix = 5) {
  const migrations = await loadMigrations()
  const state = {
    ledger: migrations.slice(0, prefix).map(({ version, name, sha256 }) => ({ version, name, sha256 })),
    ledgerPresent: prefix > 0, ciphertext: encryptProviderSecret("synthetic-provider-token", environment) as string | null,
    providerPresent: prefix >= 2, invalidIdentity: "", invalidSchema: false, schemaChecks: 0, loseCommit: false, active: 0, maximum: 0,
  }
  const events: string[] = [], sql: { purpose: DatabasePurpose; text: string }[] = []
  const dependencies: MaintenanceDependencies = {
    release: async () => release(),
    verifySchema: async (_client, configuration) => {
      assert.equal(configuration.purpose, "migration")
      state.schemaChecks++
      if (state.invalidSchema) throw new DatabaseBoundaryError("BACKUP_SCHEMA_MISMATCH", "物理表或列不满足审核契约。")
    },
    pool: purpose => ({
      connect: async () => {
        state.active++; state.maximum = Math.max(state.maximum, state.active); events.push(`connect:${purpose}`)
        return { release: () => { state.active--; events.push(`release:${purpose}`) }, query: async (text, values) => {
          sql.push({ purpose, text })
          if (text === DATABASE_IDENTITY_SQL) return { rows: [{ ...identity(purpose), ...(state.invalidIdentity === purpose ? { current_user: "other_app" } : {}) }] }
          if (text === "SELECT to_regclass('app.provider_settings') IS NOT NULL AS present") return { rows: [{ present: state.providerPresent }] }
          if (text === 'SELECT "tokenCiphertext" FROM app.provider_settings WHERE singleton=1') return { rows: state.ciphertext ? [{ tokenCiphertext: state.ciphertext }] : [] }
          assert.equal(purpose, "migration", "runtime must never read migration ledger")
          if (text === MIGRATION_LEDGER_EXISTS_SQL) return { rows: [{ present: state.ledgerPresent }] }
          if (text === MIGRATION_LEDGER_SQL) return { rows: [...state.ledger] }
          if (text.startsWith("CREATE TABLE app.schema_migrations")) state.ledgerPresent = true
          if (text === migrations[1].sql) state.providerPresent = true
          if (text.startsWith("INSERT INTO app.schema_migrations")) state.ledger.push({ version: values?.[0], name: values?.[1], sha256: values?.[2] } as MigrationLedgerEntry)
          if (text === "COMMIT" && state.loseCommit) { state.loseCommit = false; throw new Error("raw database secret must not escape") }
          return { rows: [] }
        } }
      },
      end: async () => { assert.equal(state.active, 0); events.push(`end:${purpose}`) },
    }),
  }
  return { state, dependencies, events, sql, migrations }
}
const mutations = (queries: { text: string }[]) => queries.filter(item => /^(CREATE|REVOKE|INSERT|ALTER|UPDATE|DELETE|DROP|TRUNCATE)\b/.test(item.text))

test("offline describe verifies the approved SQL set without secrets, release metadata or connections", async () => {
  const result = await runMaintenance("describe", { NODE_ENV: "test" }, { pool: () => { throw new Error("must not connect") }, release: async () => { throw new Error("must not read") } })
  assert.equal(result.application, "qintopia-image")
  assert.ok("database" in result && "connectionBudget" in result)
  assert.deepEqual(result.connectionBudget, { applicationProcesses: 2, perApplication: 4, maintenance: 1, total: 9 })
  assert.deepEqual(result.database, maintenanceDatabaseContract())
})

test("artifact and both identities/secrets are validated before any connection", async () => {
  for (const patch of [
    { IMAGE_DATABASE_URL: environment.IMAGE_DATABASE_URL.replace("qintopia_image", "other_app") },
    { IMAGE_MIGRATION_DATABASE_URL: environment.IMAGE_MIGRATION_DATABASE_URL.replace("32768", "5432") },
    { BETTER_AUTH_SECRET: "short" }, { BETTER_AUTH_URL: "https://example.test/path" }, { PROVIDER_CONFIG_KEY: "bad" },
    { PGHOST: "other_app" }, { NODE_OPTIONS: "--require private-hook.cjs" },
  ]) {
    const f = await fixture()
    await assert.rejects(runMaintenance("preflight", { ...environment, ...patch }, f.dependencies))
    assert.equal(f.sql.length, 0); assert.equal(f.events.length, 0)
  }
  for (const changed of [
    { ...release(), schema: 1 }, { ...release(), assetAccessProtocol: "bearer-v1" },
    { ...release(), database: { ...maintenanceDatabaseContract(), name: "other_app" } },
    { ...release(), database: { ...maintenanceDatabaseContract(), maxVersion: "0006" } },
    { ...release(), database: { ...maintenanceDatabaseContract(), migrations: maintenanceDatabaseContract().migrations.slice(1) } },
    { ...release(), directory: "/tmp/untrusted" },
  ]) {
    const f = await fixture(); f.dependencies.release = async () => changed
    await assert.rejects(runMaintenance("migrate", environment, f.dependencies))
    assert.equal(f.sql.length, 0)
    assert.throws(() => validateMaintenanceRelease(changed))
  }
})

test("read-only preflight reports known pending prefixes; verify requires the complete contract", async () => {
  for (const prefix of [0, 1, 2, 4, 5]) {
    const f = await fixture(prefix), result = await runMaintenance("preflight", environment, f.dependencies)
    assert.ok("pending" in result)
    assert.deepEqual(result.pending, f.migrations.slice(prefix).map(item => item.name))
    assert.equal(result.compatible, prefix === 5)
    assert.equal(f.state.schemaChecks, prefix === 5 ? 1 : 0)
    assert.equal(f.state.maximum, 1)
    assert.ok(f.events.indexOf("end:runtime") < f.events.indexOf("connect:migration"))
    assert.equal(mutations(f.sql).length, 0)
    if (prefix < 5) await assert.rejects(runMaintenance("verify", environment, f.dependencies), /审核迁移版本/)
    else {
      const verified = await runMaintenance("verify", environment, f.dependencies)
      assert.equal("compatible" in verified && verified.compatible, true)
      assert.doesNotMatch(JSON.stringify(verified), /synthetic-provider-token|tokenCiphertext|postgresql:\/\/|BETTER_AUTH_SECRET/)
    }
  }
})

test("invalid effective identity, ledger gaps/drift and undecryptable provider settings never mutate", async () => {
  for (const kind of ["runtime", "migration", "gap", "digest", "duplicate", "ciphertext", "schema"] as const) {
    const f = await fixture()
    if (kind === "runtime" || kind === "migration") f.state.invalidIdentity = kind
    if (kind === "gap") f.state.ledger.splice(1, 1)
    if (kind === "digest") f.state.ledger[1].sha256 = "0".repeat(64)
    if (kind === "duplicate") f.state.ledger.push(f.state.ledger[0])
    if (kind === "schema") f.state.invalidSchema = true
    if (kind === "ciphertext") f.state.ciphertext = encryptProviderSecret("secret", { NODE_ENV: "test", PROVIDER_CONFIG_KEY: Buffer.alloc(32, 71).toString("base64") })
    await assert.rejects(runMaintenance("migrate", environment, f.dependencies))
    assert.equal(mutations(f.sql).length, 0)
    assert.equal(f.state.active, 0)
  }
})

test("migrate applies the fixed set once; lost commit acknowledgement is resolved by read-only verify", async () => {
  const f = await fixture(0)
  const first = await runMaintenance("migrate", environment, f.dependencies)
  assert.deepEqual("applied" in first && first.applied, f.migrations.map(item => item.name))
  assert.equal("compatible" in first && first.compatible, true)
  const second = await runMaintenance("migrate", environment, f.dependencies)
  assert.deepEqual("applied" in second && second.applied, [])
  for (const migration of f.migrations) assert.equal(f.sql.filter(item => item.text === migration.sql).length, 1)
  assert.equal(f.state.maximum, 1)
  const uncertain = await fixture(3); uncertain.state.loseCommit = true
  let failure: unknown
  try { await runMaintenance("migrate", environment, uncertain.dependencies) } catch (error) { failure = error }
  assert.ok(failure)
  assert.doesNotMatch(JSON.stringify(maintenanceError(failure)), /raw database secret/)
  const before = mutations(uncertain.sql).length
  const verified = await runMaintenance("verify", environment, uncertain.dependencies)
  assert.equal("compatible" in verified && verified.compatible, true)
  assert.equal(mutations(uncertain.sql).length, before)
})
