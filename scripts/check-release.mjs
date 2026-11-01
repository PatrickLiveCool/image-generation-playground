import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const read = (file, rootDir) => readFileSync(resolve(rootDir, file), "utf8");

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function checkDatabasePolicy(policy, rootDir) {
  if (!exactKeys(policy, ["application", "version", "databaseMode", "assetAccessProtocol", "database", "browserWorkspaceSchema", "assetCapabilityVersion", "rollbackCompatibility"])
      || policy.databaseMode !== "postgresql" || policy.assetAccessProtocol !== "account-private-v1") throw new Error("Release requires the account-private-v1 PostgreSQL contract.");
  const database = policy.database;
  if (!exactKeys(database, ["name", "schema", "minVersion", "maxVersion", "migrations"])
      || database.name !== "qintopia_image" || database.schema !== "app"
      || !Array.isArray(database.migrations) || !database.migrations.length || database.migrations.length > 128) throw new Error("Invalid project database contract.");
  const catalogPath = resolve(rootDir, "scripts/database/migration-catalog.ts");
  if (!lstatSync(catalogPath).isFile() || lstatSync(catalogPath).isSymbolicLink()) throw new Error("Reviewed migration catalog is missing or linked.");
  const entries = [...readFileSync(catalogPath, "utf8").matchAll(/^\s*"([0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql)": "([0-9a-f]{64})",?\s*$/gm)]
    .map(match => ({ name: match[1], sha256: match[2] }));
  if (entries.length !== database.migrations.length) throw new Error("Database migration set differs from the reviewed catalog.");
  const directory = resolve(rootDir, "migrations");
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()
      || readdirSync(directory).sort().join("|") !== entries.map(entry => entry.name).join("|")) throw new Error("Migration directory differs from the reviewed catalog.");
  entries.forEach((entry, index) => {
    const migration = database.migrations[index];
    if (!exactKeys(migration, ["name", "sha256"]) || migration.name !== entry.name || migration.sha256 !== entry.sha256
        || entry.name.slice(0, 4) !== String(index + 1).padStart(4, "0")) throw new Error("Migrations must match the ordered reviewed catalog.");
    const file = resolve(directory, entry.name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1_048_576
        || createHash("sha256").update(readFileSync(file)).digest("hex") !== entry.sha256) throw new Error("Migration SQL differs from its reviewed digest.");
  });
  const latest = entries.at(-1).name.slice(0, 4);
  if (database.minVersion !== latest || database.maxVersion !== latest) throw new Error("Current runtime requires exactly the reviewed database version.");
}

function changelogReleaseSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## (?:\\[${escaped}\\](?:\\([^\\n]+\\))?|v?${escaped}\\b)`, "m");
  const match = heading.exec(changelog);
  return match && changelog.slice(match.index + match[0].length).split(/^## /m)[0].trim();
}

export function parseReleaseTag(value) {
  if (typeof value !== "string" || !TAG.test(value)) throw new Error("Release tag must match vX.Y.Z.");
  return value.slice(1);
}

export function checkRelease({ rootDir = root, tag, environment = process.env } = {}) {
  const packageJson = JSON.parse(read("package.json", rootDir));
  const { version } = packageJson;
  if (packageJson.name !== "qintopia-image") throw new Error("Package name must be qintopia-image.");
  if (typeof version !== "string" || !SEMVER.test(version)) throw new Error("Package version must be strict semver.");
  if (packageJson.packageManager !== "pnpm@10.28.2") throw new Error("Package manager must be pinned to pnpm@10.28.2.");
  if (read(".node-version", rootDir).trim() !== "22.22.1") throw new Error("The release runtime must be pinned to Node 22.22.1.");
  if (!read("pnpm-lock.yaml", rootDir).trim()) throw new Error("The pnpm lockfile is required.");
  if (existsSync(resolve(rootDir, "package-lock.json"))) throw new Error("Use one lockfile: pnpm-lock.yaml.");

  const environmentTag = environment.GITHUB_REF?.startsWith("refs/tags/") ? environment.GITHUB_REF.slice("refs/tags/".length) : undefined;
  if (tag !== undefined && environmentTag !== undefined && tag !== environmentTag) throw new Error("Explicit tag does not match GITHUB_REF.");
  const effectiveTag = tag ?? environmentTag;
  if (effectiveTag !== undefined && parseReleaseTag(effectiveTag) !== version) throw new Error("Release tag must match package.json version.");
  if (!changelogReleaseSection(read("CHANGELOG.md", rootDir), version)) throw new Error("CHANGELOG must contain a nonempty entry for the current version.");

  const manifest = JSON.parse(read(".release-please-manifest.json", rootDir));
  if (manifest["."] !== version) throw new Error("Release Please manifest must match package.json version.");
  const policy = JSON.parse(read("deploy/release-policy.json", rootDir));
  if (policy.application !== "qintopia-image") throw new Error("Release policy application must be qintopia-image.");
  if (policy.version !== version) throw new Error("Release policy version must match package.json version.");
  checkDatabasePolicy(policy, rootDir);
  if (policy.browserWorkspaceSchema !== 2 || policy.assetCapabilityVersion !== 1) throw new Error("Review browser workspace and asset capability compatibility before changing their versions.");
  if (!exactKeys(policy.rollbackCompatibility, ["mode", "reason"]) || !["compatible", "forward-only"].includes(policy.rollbackCompatibility.mode)
      || typeof policy.rollbackCompatibility.reason !== "string" || !policy.rollbackCompatibility.reason.trim() || policy.rollbackCompatibility.reason.length > 1000) {
    throw new Error("Release policy requires an explicit rollback compatibility mode and reason.");
  }
  return { version, tag: effectiveTag ?? `v${version}` };
}

export function parseArguments(argumentsList = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!["--tag", "--root"].includes(option) || !value || value.startsWith("--")) throw new Error("Use --tag vX.Y.Z and/or --root <source-directory>.");
    const key = option === "--tag" ? "tag" : "rootDir";
    if (key in result) throw new Error("Repeated release-check option.");
    result[key] = key === "rootDir" ? resolve(value) : value;
  }
  return result;
}

export function main({ argumentsList = process.argv.slice(2), environment = process.env } = {}) {
  const result = checkRelease({ ...parseArguments(argumentsList), environment });
  console.log(`Release ${result.tag}: package, changelog and compatibility metadata verified.`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`Release check failed: ${error.message}`); process.exitCode = 1; }
}
