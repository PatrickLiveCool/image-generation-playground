import { readFileSync, lstatSync } from "node:fs"
import { join } from "node:path"

interface ReleaseIdentityBase {
  application: "qintopia-image"
  version: string
  revision: string
  platform: "linux/amd64"
  builtAt: string
  browserWorkspaceSchema: 1
  assetCapabilityVersion: 1
}
export interface ReleaseDatabaseContract {
  name: "qintopia_image"
  schema: "app"
  minVersion: string
  maxVersion: string
  migrations: Array<{ name: string; sha256: string }>
}
export interface LegacyReleaseIdentity extends ReleaseIdentityBase { schema: 1 }
export interface AccountReleaseIdentity extends ReleaseIdentityBase {
  schema: 2
  databaseMode: "postgresql"
  assetAccessProtocol: "account-private-v1"
  database: ReleaseDatabaseContract
}
export type ReleaseIdentity = LegacyReleaseIdentity | AccountReleaseIdentity

const VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const REVISION = /^[0-9a-f]{40}$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).sort().join("|") === keys.sort().join("|") }

export function validateReleaseDatabaseContract(value: unknown): ReleaseDatabaseContract {
  const invalid = () => { throw new Error("Release database contract is invalid") }
  if (!object(value) || !exactKeys(value, ["name", "schema", "minVersion", "maxVersion", "migrations"])
    || value.name !== "qintopia_image" || value.schema !== "app"
    || typeof value.minVersion !== "string" || !/^[0-9]{4}$/.test(value.minVersion) || value.minVersion === "0000"
    || typeof value.maxVersion !== "string" || !/^[0-9]{4}$/.test(value.maxVersion) || value.maxVersion === "0000"
    || !Array.isArray(value.migrations) || value.migrations.length < 1 || value.migrations.length > 128) return invalid()
  const migrations = value.migrations.map((entry: unknown, index: number) => {
    if (!object(entry) || !exactKeys(entry, ["name", "sha256"]) || typeof entry.name !== "string"
      || !/^[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/.test(entry.name)
      || entry.name.slice(0, 4) !== String(index + 1).padStart(4, "0")
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return invalid()
    return { name: entry.name, sha256: entry.sha256 }
  })
  if (!migrations.some(entry => entry.name.startsWith(value.minVersion as string))
    || value.minVersion > value.maxVersion || value.maxVersion !== migrations.at(-1)!.name.slice(0, 4)) return invalid()
  return { name: "qintopia_image", schema: "app", minVersion: value.minVersion, maxVersion: value.maxVersion, migrations }
}

/** Public output is reconstructed from verified fields; extra metadata never becomes a public response. */
export function validateReleaseIdentity(value: unknown): ReleaseIdentity {
  if (!object(value)) throw new Error("Release identity is unavailable")
  if (![1, 2].includes(value.schema as number) || value.application !== "qintopia-image"
    || typeof value.version !== "string" || !VERSION.test(value.version)
    || typeof value.revision !== "string" || !REVISION.test(value.revision)
    || value.platform !== "linux/amd64"
    || typeof value.builtAt !== "string" || !UTC.test(value.builtAt) || !Number.isFinite(Date.parse(value.builtAt))
    || new Date(value.builtAt).toISOString().slice(0, 19) !== value.builtAt.slice(0, 19)
    || value.browserWorkspaceSchema !== 1 || value.assetCapabilityVersion !== 1) throw new Error("Release identity is invalid")
  const base: ReleaseIdentityBase = {
    application: "qintopia-image", version: value.version, revision: value.revision,
    platform: "linux/amd64", builtAt: value.builtAt,
    browserWorkspaceSchema: 1, assetCapabilityVersion: 1,
  }
  if (value.schema === 1) {
    if ("database" in value || "databaseMode" in value || "assetAccessProtocol" in value) throw new Error("Release identity is invalid")
    return { ...base, schema: 1 }
  }
  if (value.databaseMode !== "postgresql" || value.assetAccessProtocol !== "account-private-v1") throw new Error("Release identity is invalid")
  return { ...base, schema: 2, databaseMode: "postgresql", assetAccessProtocol: "account-private-v1", database: validateReleaseDatabaseContract(value.database) }
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
