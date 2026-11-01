import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
import { isBuiltin } from "node:module"
import { closeSync, copyFileSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { initializeAdministrator, verifyInitializedAdministrator, VERIFY_BOOTSTRAP_SQL } from "../lib/auth/bootstrap-administrator"
import { AccountError } from "../lib/auth/errors"
import { DatabaseBoundaryError, type DatabaseInspectionClient } from "../lib/database-target"
import { MAX_ADMINISTRATOR_INPUT_BYTES, readAdministratorInput } from "../scripts/database/administrator"
import { maintenanceDatabaseContract, readAdministratorConfiguration } from "../scripts/database/maintenance"

const root = fileURLToPath(new URL("../", import.meta.url))
const input = { username: " Test_Admin ", name: " 合成管理员 ", password: "Synthetic-bootstrap-password-123" }
const environment = { NODE_ENV: "test" as const, IMAGE_DATABASE_TARGET: "local",
  IMAGE_DATABASE_URL: "postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image" }

test("shared administrator core preserves first-only creation and verifies the same credentials, state and audit without writes", async () => {
  let user: Record<string, unknown> | undefined, password = "", bootstrapped = false
  const queries: string[] = []
  const client: DatabaseInspectionClient = { query: async (text, values = []) => {
    queries.push(text)
    if (text === VERIFY_BOOTSTRAP_SQL) return { rows: user ? [{ ...user, password, bootstrapped, initialized: true }] : [{ initialized: false }] }
    if (text.startsWith('SELECT id FROM app."user"')) return { rows: user ? [{ id: user.id }] : [] }
    if (text.startsWith('INSERT INTO app."user"')) {
      user = { id: values[0], username: values[3], name: values[1], role: values[4], banned: false, mustChangePassword: values[5], createdAt: new Date().toISOString() }
      return { rows: [user] }
    }
    if (text.startsWith("INSERT INTO app.account (")) password = String(values[3])
    if (text.startsWith("INSERT INTO app.account_audit")) { assert.equal(values[0], values[1]); assert.equal(values[2], "bootstrap-admin"); bootstrapped = true }
    return { rows: [] }
  } }
  const created = await initializeAdministrator(input, operation => operation(client))
  assert.equal(created.username, "test_admin"); assert.equal(created.name, "合成管理员")
  assert.notEqual(password, input.password)
  assert.deepEqual(await verifyInitializedAdministrator(client, input), { verified: true, administratorId: created.id })
  const initialHash = password
  await assert.rejects(initializeAdministrator(input, operation => operation(client)), error => error instanceof AccountError && error.code === "ADMIN_EXISTS")
  assert.equal(password, initialHash)
  assert.equal(queries.filter(sql => sql.startsWith("INSERT")).length, 3)
  const before = queries.length, original = { ...user }
  for (const patch of [{ role: "user" }, { banned: true }, { mustChangePassword: true }, { username: "different" }, { name: "different" }]) {
    user = { ...original, ...patch }
    await assert.rejects(verifyInitializedAdministrator(client, input), error => error instanceof AccountError && error.code === "ADMIN_BOOTSTRAP_MISMATCH")
  }
  user = original; bootstrapped = false
  await assert.rejects(verifyInitializedAdministrator(client, input), AccountError)
  bootstrapped = true
  await assert.rejects(verifyInitializedAdministrator(client, { ...input, password: "Wrong-bootstrap-password-123" }), AccountError)
  assert.ok(queries.slice(before).every(sql => sql === VERIFY_BOOTSTRAP_SQL || sql === "SELECT pg_advisory_xact_lock($1)"))
})

test("administrator FD input is bounded and strict; unrelated secrets are rejected before connection", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "image-admin-input-")), fd = openSync(path.join(scratch, "input"), "wx+", 0o600)
  const replace = (value: Uint8Array) => { ftruncateSync(fd, 0); writeFileSync(path.join(scratch, "input"), value) }
  try {
    replace(Buffer.from(JSON.stringify(input)))
    assert.deepEqual(readAdministratorInput(fd), { ...input, username: "test_admin", name: "合成管理员" })
    for (const value of ["not-json", JSON.stringify({ ...input, sql: "DROP DATABASE other" }), JSON.stringify({ ...input, password: "short" }), "[]"]) {
      replace(Buffer.from(value)); assert.throws(() => readAdministratorInput(fd), AccountError)
    }
    replace(Buffer.from([0xff, 0xfe])); assert.throws(() => readAdministratorInput(fd), AccountError)
    ftruncateSync(fd, MAX_ADMINISTRATOR_INPUT_BYTES + 1)
    assert.throws(() => readAdministratorInput(fd), DatabaseBoundaryError)
    assert.equal(readAdministratorConfiguration(environment).purpose, "runtime")
    for (const key of ["IMAGE_MIGRATION_DATABASE_URL", "IMAGE_RECOVERY_KEY", "BETTER_AUTH_SECRET", "PROVIDER_CONFIG_KEY", "ASSET_ACCESS_SECRET", "BOOTSTRAP_ADMIN_PASSWORD", "PGHOST", "NODE_OPTIONS"]) {
      assert.throws(() => readAdministratorConfiguration({ ...environment, [key]: "must-not-be-forwarded" }), DatabaseBoundaryError)
    }
  } finally { closeSync(fd); rmSync(scratch, { recursive: true, force: true }) }
})

test("bundled administrator commands use runtime only and resolve a lost commit by read-only credential verification", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "image-admin-bundle-")), runtime = path.join(scratch, "runtime"), maintenance = path.join(runtime, "maintenance")
  mkdirSync(path.join(maintenance, "migrations"), { recursive: true })
  const release = { schema: 2, application: "qintopia-image", version: "v0.3.0", revision: "a".repeat(40), platform: "linux/amd64",
    builtAt: "2026-10-29T00:00:00Z", browserWorkspaceSchema: 2, assetCapabilityVersion: 1, databaseMode: "postgresql", assetAccessProtocol: "account-private-v1", database: maintenanceDatabaseContract() }
  const identity = { database: "qintopia_image", current_user: "qintopia_image_app", session_user: "qintopia_image_app", schema: "app", search_path: "app, pg_catalog",
    database_owner: "qintopia_image_migrator", schema_owner: "qintopia_image_migrator", can_connect: true, can_use_schema: true,
    can_create_database_objects: false, can_temp: false, can_create_schema_objects: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
    rolreplication: false, rolbypassrls: false, has_memberships: false, can_create_outside_schema: false, can_write_outside_schema: false,
    can_write_sequences_outside_schema: false, unexpected_object_owner: false, runtime_table_permissions_invalid: false, runtime_sequence_permissions_invalid: false, runtime_can_access_ledger: false }
  const source = `
    import { runMaintenance, maintenanceError } from ${JSON.stringify(path.join(root, "scripts/database/maintenance.ts"))};
    import { DATABASE_IDENTITY_SQL } from ${JSON.stringify(path.join(root, "lib/database-target.ts"))};
    import { VERIFY_BOOTSTRAP_SQL } from ${JSON.stringify(path.join(root, "lib/auth/bootstrap-administrator.ts"))};
    let user, password, bootstrapped=false, lost=true, readonly=false, active=0, maximum=0;
    const queries=[];
    const options={ release:async()=>(${JSON.stringify(release)}), verifySchema:async()=>{throw Error("bootstrap must not open migration identity")},
      pool:purpose=>{
        if(purpose!=="runtime") throw Error("wrong identity");
        return {connect:async()=>{active++;maximum=Math.max(maximum,active);return {release:()=>{active--},query:async(text,values=[])=>{
          queries.push(text);
          if(text===DATABASE_IDENTITY_SQL)return{rows:[${JSON.stringify(identity)}]};
          if(text===VERIFY_BOOTSTRAP_SQL)return{rows:user?[{...user,password,bootstrapped,initialized:true}]:[{initialized:false}]};
          if(text.startsWith('SELECT id FROM app."user"'))return{rows:user?[{id:user.id}]:[]};
          if(text==='BEGIN')readonly=false;
          if(text==='BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY')readonly=true;
          if(readonly && /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/.test(text))throw Error("read-only command mutated data");
          if(text.startsWith('INSERT INTO app."user"')){user={id:values[0],name:values[1],username:values[3],role:values[4],banned:false,mustChangePassword:values[5]};return{rows:[user]};}
          if(text.startsWith('INSERT INTO app.account ('))password=values[3];
          if(text.startsWith('INSERT INTO app.account_audit'))bootstrapped=true;
          if(text==='COMMIT' && !readonly && lost){lost=false;if(process.argv[2]==='not-committed'){user=undefined;password=undefined;bootstrapped=false};throw Error("synthetic lost acknowledgement with sensitive details")};
          return{rows:[]};
        }}},end:async()=>{if(active)throw Error("pool leaked")}};
      }};
    const environment=${JSON.stringify(environment)};
    const first=await runMaintenance('bootstrap-admin',environment,options).catch(maintenanceError);
    const before=queries.length;
    const verified=await runMaintenance('verify-bootstrap-admin',environment,options);
    const verifyReadOnly=queries.slice(before).every(sql=>sql===DATABASE_IDENTITY_SQL || sql===VERIFY_BOOTSTRAP_SQL || sql==='SELECT pg_advisory_xact_lock($1)' || sql==='BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' || sql==='COMMIT');
    const repeated=await runMaintenance('bootstrap-admin',environment,options).catch(maintenanceError);
    console.log(JSON.stringify({first,verified,repeated,verifyReadOnly,maximum,inserts:queries.filter(sql=>sql.startsWith('INSERT')).length}));
  `
  let descriptor: number | undefined
  try {
    for (const name of readdirSync(path.join(root, "migrations"))) copyFileSync(path.join(root, "migrations", name), path.join(maintenance, "migrations", name))
    symlinkSync(path.join(root, "node_modules"), path.join(runtime, "node_modules"), "dir")
    const entry = path.join(maintenance, "harness.mjs")
    const built = await build({ stdin: { contents: source, resolveDir: root, loader: "ts" }, outfile: entry, bundle: true,
      platform: "node", target: "node22", format: "esm", external: ["pg"], metafile: true, define: { __IMAGE_MAINTENANCE_BUNDLE__: "true" }, logLevel: "silent" })
    assert.ok(Object.values(built.metafile.outputs).every(output => output.imports.every(item => !item.external || item.path === "pg" || isBuiltin(item.path))))
    const filename = path.join(scratch, "input.json"); writeFileSync(filename, JSON.stringify(input), { mode: 0o600 }); descriptor = openSync(filename, "r")
    for (const outcome of ["committed", "not-committed"]) {
      const child: SpawnSyncReturns<string> = spawnSync(process.execPath, [entry, outcome], { cwd: runtime, env: { NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe", descriptor], encoding: "utf8", timeout: 20_000 })
      assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, "")
      assert.doesNotMatch(child.stdout, /Test_Admin|test_admin|Synthetic-bootstrap-password|合成管理员|sensitive details/)
      const value = JSON.parse(child.stdout)
      assert.equal(value.first.error.code, "ADMIN_BOOTSTRAP_UNCONFIRMED")
      assert.equal(value.verified.command, "verify-bootstrap-admin")
      if (outcome === "committed") {
        assert.equal(value.verified.verified, true); assert.equal(value.repeated.error.code, "ADMIN_EXISTS"); assert.equal(value.inserts, 3)
      } else {
        assert.equal(value.verified.uninitialized, true); assert.equal("administratorId" in value.verified, false)
        assert.equal(value.repeated.initialized, true); assert.equal(value.inserts, 6, "second explicit call can initialize after verified absence")
      }
      assert.equal(value.maximum, 1); assert.equal(value.verifyReadOnly, true)
    }
  } finally { if (descriptor !== undefined) closeSync(descriptor); rmSync(scratch, { recursive: true, force: true }) }
})
