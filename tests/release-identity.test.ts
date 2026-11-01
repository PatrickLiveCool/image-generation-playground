import { strict as assert } from "node:assert"
import { test } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// @ts-expect-error Node's built-in TypeScript runner requires the file extension.
import { readReleaseIdentity, validateReleaseIdentity } from "../lib/release-identity.ts"

const identity = {
  schema: 1, application: "qintopia-image", version: "v0.2.0", revision: "a".repeat(40),
  platform: "linux/amd64", builtAt: "2026-10-26T00:00:00.000Z",
  browserWorkspaceSchema: 1, assetCapabilityVersion: 1,
}
const accountIdentity = { ...identity, schema: 2, databaseMode: "postgresql", assetAccessProtocol: "account-private-v1",
  database: JSON.parse(readFileSync(new URL("../deploy/release-policy.json", import.meta.url), "utf8")).database }

test("account identity includes the bounded project migration contract without publishing extra data", () => {
  const result = validateReleaseIdentity({ ...accountIdentity, privateEnvironment: "must-not-publish" })
  assert.deepEqual(result, accountIdentity)
  assert.doesNotMatch(JSON.stringify(result), /must-not-publish/)
  assert.throws(() => validateReleaseIdentity({ ...accountIdentity, schema: 1 }), /invalid/)
  assert.throws(() => validateReleaseIdentity({ ...accountIdentity, databaseMode: "none" }), /invalid/)
  assert.throws(() => validateReleaseIdentity({ ...accountIdentity, assetAccessProtocol: "public-bearer" }), /invalid/)
})

test("account identity rejects cross-project, incomplete or ambiguous migration contracts", () => {
  for (const change of [
    (value: any) => { value.name = "other_database" },
    (value: any) => { value.schema = "public" },
    (value: any) => { value.minVersion = "0000" },
    (value: any) => { value.maxVersion = "9999" },
    (value: any) => { value.migrations.reverse() },
    (value: any) => { value.migrations.pop() },
    (value: any) => { value.migrations[0].name = "../0001-accounts.sql" },
    (value: any) => { value.migrations[0].sha256 = "bad" },
    (value: any) => { value.migrations[0].secret = "must-not-publish" },
  ]) {
    const database = structuredClone(accountIdentity.database)
    change(database)
    assert.throws(() => validateReleaseIdentity({ ...accountIdentity, database }), /invalid/)
  }
  for (const stamp of ["2026-02-30T00:00:00Z", "2026-10-26T00:00:00+08:00", "2026-10-26"]) {
    assert.throws(() => validateReleaseIdentity({ ...accountIdentity, builtAt: stamp }), /invalid/)
  }
})

test("release identity reports only the verified artifact fields", () => {
  const result = validateReleaseIdentity({ ...identity, apiKey: "not-public", environment: { COS_SECRET_KEY: "not-public" } })
  assert.deepEqual(result, identity)
  assert.equal(JSON.stringify(result).includes("not-public"), false)
})

test("release identity rejects ambiguous versions, incomplete revisions and incompatible data formats", () => {
  for (const patch of [
    { version: "0.2.0" }, { version: "v00.2.0" }, { version: "v0.2.0; reboot" },
    { revision: "a".repeat(7) }, { application: "greenpms" }, { platform: "darwin/arm64" },
    { builtAt: "invalid" }, { browserWorkspaceSchema: 2 }, { assetCapabilityVersion: 2 },
  ]) assert.throws(() => validateReleaseIdentity({ ...identity, ...patch }), /invalid/)
})

test("missing, malformed, oversized and linked metadata fail closed without exposing the path", () => {
  const directory = mkdtempSync(join(tmpdir(), "image-identity-"))
  try {
    const check = () => assert.throws(() => readReleaseIdentity(directory), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, "Verified release metadata is unavailable")
      assert.equal(error.message.includes(directory), false)
      return true
    })
    check()
    writeFileSync(join(directory, "release.json"), "{")
    check()
    writeFileSync(join(directory, "release.json"), " ".repeat(16_385))
    check()
    rmSync(join(directory, "release.json"))
    writeFileSync(join(directory, "other.json"), JSON.stringify(identity))
    symlinkSync(join(directory, "other.json"), join(directory, "release.json"))
    check()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("artifact identity does not follow a conflicting environment version label", () => {
  const directory = mkdtempSync(join(tmpdir(), "image-identity-"))
  const previous = process.env.APP_RELEASE
  try {
    writeFileSync(join(directory, "release.json"), JSON.stringify(identity))
    process.env.APP_RELEASE = "unverified-label"
    assert.deepEqual(readReleaseIdentity(directory), identity)
  } finally {
    if (previous === undefined) delete process.env.APP_RELEASE
    else process.env.APP_RELEASE = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
