import assert from "node:assert/strict"
import { test } from "node:test"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { closeSync, fchmodSync, ftruncateSync, linkSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { DatabaseBoundaryError } from "../lib/database-target"
import { decodeProjectBackup, encodeProjectBackup, MAX_PROJECT_RECOVERY_SECRETS_BYTES, PROJECT_BACKUP_TABLES, projectBackupStorage, projectRecoverySecrets, type ProjectBackupPayload } from "../lib/project-backup"
import { maintenanceDatabaseContract } from "../scripts/database/maintenance"
import { MAX_RECOVERY_ARCHIVE_BYTES, MAX_RECOVERY_SECRETS_BYTES, prepareRecoveryOutput, readRecoveryInput, recoveryKey, writeRecoveryOutput } from "../scripts/database/recovery-io"

const root = fileURLToPath(new URL("../", import.meta.url))
const environment = { NODE_ENV: "test" as const, IMAGE_DATABASE_TARGET: "local", IMAGE_RECOVERY_KEY: Buffer.alloc(32, 37).toString("base64"),
  IMAGE_DATABASE_URL: "postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image",
  IMAGE_MIGRATION_DATABASE_URL: "postgresql://qintopia_image_migrator:synthetic-local-migrator-only@127.0.0.1:32768/qintopia_image",
  BETTER_AUTH_URL: "http://localhost:3108", BETTER_AUTH_SECRET: "synthetic-backup-auth-secret-32-characters",
  PROVIDER_CONFIG_KEY: Buffer.alloc(32, 61).toString("base64"), ASSET_ACCESS_SECRET: "synthetic-backup-asset-secret-32-characters",
  COS_BUCKET: "synthetic-private-1234567890", COS_REGION: "ap-shanghai" }
const release = { schema: 2, application: "qintopia-image", version: "v0.3.0", revision: "a".repeat(40), platform: "linux/amd64",
  builtAt: "2026-10-30T00:00:00Z", browserWorkspaceSchema: 2, assetCapabilityVersion: 1, databaseMode: "postgresql", assetAccessProtocol: "account-private-v1", database: maintenanceDatabaseContract() }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`
  return JSON.stringify(value)
}
function archive(secretPatch: Partial<NodeJS.ProcessEnv> = {}) {
  const content = { schema: 1, application: "qintopia-image", database: "qintopia_image", schemaName: "app", createdAt: new Date(Date.now() - 60_000).toISOString(), release,
    migrations: release.database.migrations, storage: projectBackupStorage(environment), secrets: projectRecoverySecrets({ ...environment, ...secretPatch }),
    tables: Object.fromEntries(PROJECT_BACKUP_TABLES.map(table => [table, []])) }
  return encodeProjectBackup({ ...content, contentSha256: createHash("sha256").update(canonical(content)).digest("hex") } as unknown as ProjectBackupPayload, recoveryKey(environment))
}
function sealUntrusted(payload: ProjectBackupPayload): Buffer {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", recoveryKey(environment), nonce)
  cipher.setAAD(Buffer.from("qintopia-image:structured-project-backup:v1"))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()])
  return Buffer.from(JSON.stringify({ schema: 1, application: "qintopia-image", algorithm: "aes-256-gcm", nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") }))
}

test("recovery descriptors reject public modes, hard links, oversized/nonempty files and stdout", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "image-recovery-io-")), filename = path.join(scratch, "slot")
  const fd = openSync(filename, "wx+", 0o600)
  try {
    assert.throws(() => readRecoveryInput(fd), DatabaseBoundaryError)
    writeRecoveryOutput(fd, Buffer.from("encrypted-placeholder"), MAX_RECOVERY_ARCHIVE_BYTES)
    assert.equal(readRecoveryInput(fd).toString(), "encrypted-placeholder")
    assert.throws(() => writeRecoveryOutput(fd, Buffer.from("overwrite"), MAX_RECOVERY_ARCHIVE_BYTES), DatabaseBoundaryError)
    fchmodSync(fd, 0o640); assert.throws(() => readRecoveryInput(fd), DatabaseBoundaryError); fchmodSync(fd, 0o600)
    linkSync(filename, path.join(scratch, "alias")); assert.throws(() => readRecoveryInput(fd), DatabaseBoundaryError); unlinkSync(path.join(scratch, "alias"))
    ftruncateSync(fd, MAX_RECOVERY_ARCHIVE_BYTES + 1); assert.throws(() => readRecoveryInput(fd), DatabaseBoundaryError)
    ftruncateSync(fd, 0)
    assert.throws(() => writeRecoveryOutput(fd, Buffer.alloc(MAX_RECOVERY_SECRETS_BYTES + 1), MAX_RECOVERY_SECRETS_BYTES), DatabaseBoundaryError)
    assert.throws(() => prepareRecoveryOutput(1, MAX_RECOVERY_SECRETS_BYTES), DatabaseBoundaryError)
    const readonly = openSync(filename, "r")
    try { assert.throws(() => prepareRecoveryOutput(readonly, MAX_RECOVERY_SECRETS_BYTES), DatabaseBoundaryError) } finally { closeSync(readonly) }
    for (const key of ["", "bad", environment.IMAGE_RECOVERY_KEY + "\n", Buffer.alloc(31).toString("base64")]) {
      assert.throws(() => recoveryKey({ ...environment, IMAGE_RECOVERY_KEY: key }), DatabaseBoundaryError)
    }
  } finally { closeSync(fd); rmSync(scratch, { recursive: true, force: true }) }
})

test("fixed recovery fd protocol authenticates before connecting and accepts archive secrets when target keys are stale", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "image-recovery-command-"))
  const source = `
    const { runRecoveryMaintenance } = require(${JSON.stringify(path.join(root, "scripts/database/recovery-io.ts"))});
    const { maintenanceError } = require(${JSON.stringify(path.join(root, "scripts/database/maintenance.ts"))});
    const { readDatabaseConfiguration } = require(${JSON.stringify(path.join(root, "lib/database-target.ts"))});
    (async () => {
    let reachedRuntime = false;
    try {
      const result = await runRecoveryMaintenance(process.argv[2], process.env, ${JSON.stringify(release)}, readDatabaseConfiguration("migration",process.env), {
        runtime: async () => { reachedRuntime = true; throw new Error("synthetic stop before any database access"); },
        migration: async () => { throw new Error("must not connect"); }
      });
      console.log(JSON.stringify({ reachedRuntime, result }));
    } catch (error) { console.log(JSON.stringify({ reachedRuntime, ...maintenanceError(error) })); }
    })();
  `
  const harness = path.join(scratch, "harness.cts")
  writeFileSync(harness, source)
  function run(command: string, bytes: Buffer, patch: Record<string, string> = {}) {
    const input = path.join(scratch, "input"), output = path.join(scratch, "output")
    writeFileSync(input, bytes, { mode: 0o600 }); writeFileSync(output, "", { mode: 0o600 })
    const inputFd = openSync(input, "r"), outputFd = openSync(output, "r+")
    try {
      const child = spawnSync(process.execPath, ["--import", "tsx", harness, command], { cwd: root,
        env: { ...environment, ...patch }, stdio: command === "restore-preflight" ? ["ignore", "pipe", "pipe", inputFd] : ["ignore", "pipe", "pipe", inputFd, outputFd], encoding: "utf8", timeout: 10_000 })
      assert.equal(child.status, 0, child.stderr)
      assert.equal(child.stderr, "")
      assert.equal(readFileSync(output).length, 0, "no secrets written before successful database verification")
      assert.doesNotMatch(child.stdout, /synthetic-backup|BETTER_AUTH_SECRET|PROVIDER_CONFIG_KEY|ASSET_ACCESS_SECRET/)
      return JSON.parse(child.stdout)
    } finally { closeSync(inputFd); closeSync(outputFd) }
  }
  try {
    const encrypted = archive()
    for (const command of ["restore-preflight", "restore", "verify-restore"]) {
      const valid = run(command, encrypted, { BETTER_AUTH_SECRET: "stale", PROVIDER_CONFIG_KEY: "invalid-stale-key", ASSET_ACCESS_SECRET: "stale" })
      assert.equal(valid.reachedRuntime, true)
      const wrongStorage = run(command, encrypted, { COS_BUCKET: "another-private-1234567890" })
      assert.equal(wrongStorage.reachedRuntime, false); assert.equal(wrongStorage.error.code, "BACKUP_STORAGE_MISMATCH")
      const unauthenticated = run(command, Buffer.from("not-an-archive"))
      assert.equal(unauthenticated.reachedRuntime, false); assert.equal(unauthenticated.error.code, "BACKUP_AUTHENTICATION_FAILED")
      for (const control of ["\r", "\n", "\0"]) {
        const invalidSecret = decodeProjectBackup(encrypted, recoveryKey(environment))
        invalidSecret.secrets.BETTER_AUTH_SECRET += control
        const { contentSha256: _digest, ...content } = invalidSecret
        invalidSecret.contentSha256 = createHash("sha256").update(canonical(content)).digest("hex")
        const rejected = run(command, sealUntrusted(invalidSecret))
        assert.equal(rejected.reachedRuntime, false)
        assert.equal(rejected.error.code, "BACKUP_AUTHENTICATION_FAILED")
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test("all recovery commands accept bounded multibyte secrets and readonly notRestored leaves FD4 empty", () => {
  assert.equal(MAX_RECOVERY_SECRETS_BYTES, MAX_PROJECT_RECOVERY_SECRETS_BYTES)
  assert.equal(MAX_RECOVERY_SECRETS_BYTES, 64 * 1024)
  const patch = { BETTER_AUTH_SECRET: "中".repeat(4096), ASSET_ACCESS_SECRET: "文".repeat(4096) }
  const bytes = archive(patch), payload = decodeProjectBackup(bytes, recoveryKey(environment))
  const serialized = JSON.stringify(payload.secrets) + "\n"
  assert.ok(Buffer.byteLength(serialized) > 16_384, "valid secrets exceeded the previous FD4 limit")
  const scratch = mkdtempSync(path.join(tmpdir(), "image-recovery-receipt-"))
  const harness = path.join(scratch, "harness.cts")
  writeFileSync(harness, `
    const { runRecoveryMaintenance } = require(${JSON.stringify(path.join(root, "scripts/database/recovery-io.ts"))});
    const { maintenanceError } = require(${JSON.stringify(path.join(root, "scripts/database/maintenance.ts"))});
    const { readDatabaseConfiguration } = require(${JSON.stringify(path.join(root, "lib/database-target.ts"))});
    (async () => {
      const events = [];
      try {
        const command = process.argv[2], absent = process.argv[3] === "absent";
        // Fake only the database adapter result: real authenticated archive parsing and protected FD I/O execute.
        const result = await runRecoveryMaintenance(command, process.env, ${JSON.stringify(release)}, readDatabaseConfiguration("migration", process.env), {
          runtime: async () => { events.push("runtime"); },
          migration: async () => { events.push("migration"); return {
            contentSha256: ${JSON.stringify(payload.contentSha256)}, rowCount: 0,
            ...(command === "restore-preflight" ? { ready: true } : command === "restore" ? { restored: true } : absent ? { notRestored: true } : { verified: true }),
            secrets: { neverPrint: "synthetic-private-db-result" }
          }; }
        });
        console.log(JSON.stringify({ events, result }));
      } catch (error) { console.log(JSON.stringify({ events, ...maintenanceError(error) })); }
    })();
  `)
  try {
    for (const [command, absent] of [["restore-preflight", false], ["restore", false], ["verify-restore", false], ["verify-restore", true]] as const) {
      const input = path.join(scratch, "input"), output = path.join(scratch, "output")
      writeFileSync(input, bytes, { mode: 0o600 }); writeFileSync(output, "", { mode: 0o600 })
      const inputFd = openSync(input, "r"), outputFd = openSync(output, "r+")
      try {
        const child = spawnSync(process.execPath, ["--import", "tsx", harness, command, absent ? "absent" : "present"], { cwd: root,
          env: { ...environment, BETTER_AUTH_SECRET: "stale", PROVIDER_CONFIG_KEY: "invalid-stale-key", ASSET_ACCESS_SECRET: "stale" },
          stdio: command === "restore-preflight" ? ["ignore", "pipe", "pipe", inputFd] : ["ignore", "pipe", "pipe", inputFd, outputFd], encoding: "utf8", timeout: 10_000 })
        assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, "")
        assert.doesNotMatch(child.stdout, /中|文|synthetic-private-db-result|BETTER_AUTH_SECRET|PROVIDER_CONFIG_KEY|ASSET_ACCESS_SECRET/)
        const receipt = JSON.parse(child.stdout)
        assert.deepEqual(receipt.events, ["runtime", "migration"], "no automatic restore attempt is allowed")
        const identity = { application: "qintopia-image", command, release: { version: release.version, revision: release.revision } }
        if (absent) {
          assert.deepEqual(receipt.result, { ...identity, notRestored: true, contentSha256: payload.contentSha256, rowCount: 0, secretsPrepared: false })
          assert.equal(readFileSync(output).length, 0)
        } else if (command === "restore-preflight") {
          assert.deepEqual(receipt.result, { ...identity, ready: true, contentSha256: payload.contentSha256, rowCount: 0 })
          assert.equal(readFileSync(output).length, 0)
        } else {
          assert.deepEqual(receipt.result, { ...identity, contentSha256: payload.contentSha256, rowCount: 0, secretsPrepared: true,
            ...(command === "restore" ? { restored: true } : { verified: true }) })
          const prepared = readFileSync(output, "utf8")
          assert.equal(Buffer.byteLength(prepared), Buffer.byteLength(serialized))
          assert.ok(prepared.endsWith("\n"))
          assert.equal(createHash("sha256").update(canonical(JSON.parse(prepared))).digest("hex"),
            createHash("sha256").update(canonical(payload.secrets)).digest("hex"))
        }
      } finally { closeSync(inputFd); closeSync(outputFd) }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
