import { strict as assert } from "node:assert"
import { test } from "node:test"
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// @ts-expect-error Node's built-in TypeScript runner requires the file extension.
import { readReleaseIdentity, validateReleaseIdentity } from "../lib/release-identity.ts"

const identity = {
  schema: 1, application: "qintopia-image", version: "v0.2.0", revision: "a".repeat(40),
  platform: "linux/amd64", builtAt: "2026-10-26T00:00:00.000Z",
  browserWorkspaceSchema: 1, assetCapabilityVersion: 1,
}

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
