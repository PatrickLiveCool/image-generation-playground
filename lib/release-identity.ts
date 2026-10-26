import { readFileSync, lstatSync } from "node:fs"
import { join } from "node:path"

export interface ReleaseIdentity {
  schema: 1
  application: "qintopia-image"
  version: string
  revision: string
  platform: "linux/amd64"
  builtAt: string
  browserWorkspaceSchema: 1
  assetCapabilityVersion: 1
}

const VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const REVISION = /^[0-9a-f]{40}$/

/** Release identity comes from the verified artifact, never a caller's headers or environment labels. */
export function validateReleaseIdentity(value: unknown): ReleaseIdentity {
  if (!value || typeof value !== "object") throw new Error("Release identity is unavailable")
  const identity = value as Record<string, unknown>
  if (identity.schema !== 1 || identity.application !== "qintopia-image"
    || typeof identity.version !== "string" || !VERSION.test(identity.version)
    || typeof identity.revision !== "string" || !REVISION.test(identity.revision)
    || identity.platform !== "linux/amd64"
    || typeof identity.builtAt !== "string" || !Number.isFinite(Date.parse(identity.builtAt))
    || identity.browserWorkspaceSchema !== 1 || identity.assetCapabilityVersion !== 1) {
    throw new Error("Release identity is invalid")
  }
  return {
    schema: 1, application: "qintopia-image", version: identity.version, revision: identity.revision,
    platform: "linux/amd64", builtAt: identity.builtAt,
    browserWorkspaceSchema: 1, assetCapabilityVersion: 1,
  }
}

export function readReleaseIdentity(directory = process.cwd()): ReleaseIdentity {
  try {
    const file = join(directory, "release.json")
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 16_384) throw new Error("Invalid metadata file")
    return validateReleaseIdentity(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    throw new Error("Verified release metadata is unavailable")
  }
}
