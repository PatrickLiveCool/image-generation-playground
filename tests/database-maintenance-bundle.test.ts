import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "esbuild"
import { mkdtemp, mkdir, copyFile, readdir, rm, symlink, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isBuiltin } from "node:module"

const root = fileURLToPath(new URL("../", import.meta.url))

test("bundled Node CLI runs without tsx and rejects extra arguments, altered SQL and symlink sources", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "image-maintenance-bundle-")), runtime = path.join(scratch, "runtime")
  const maintenance = path.join(runtime, "maintenance"), migrations = path.join(maintenance, "migrations")
  await mkdir(migrations, { recursive: true })
  try {
    for (const name of await readdir(path.join(root, "migrations"))) await copyFile(path.join(root, "migrations", name), path.join(migrations, name))
    // 仅提供运行依赖；CLI/迁移使用这个独立临时目录，不能读取仓库TS或源码SQL。
    await symlink(path.join(root, "node_modules"), path.join(runtime, "node_modules"), "dir")
    const built = await build({ absWorkingDir: root, entryPoints: ["scripts/database/cli.ts"], outfile: path.join(maintenance, "cli.mjs"),
      bundle: true, platform: "node", target: "node22", format: "esm", external: ["pg"], metafile: true, define: { __IMAGE_MAINTENANCE_BUNDLE__: "true" }, logLevel: "silent" })
    assert.ok(Object.values(built.metafile.outputs).every(output => output.imports.every(entry => !entry.external || entry.path === "pg" || isBuiltin(entry.path))))
    const run = (...args: string[]) => spawnSync(process.execPath, [path.join(maintenance, "cli.mjs"), ...args], {
      cwd: runtime, env: { NODE_ENV: "test", PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000,
    })
    const described = run("describe")
    assert.equal(described.status, 0, described.stderr)
    const descriptor = JSON.parse(described.stdout)
    assert.equal(descriptor.protocol, "account-private-v1")
    assert.equal(descriptor.database.migrations.length, 5)
    assert.deepEqual(descriptor.commands, ["describe", "preflight", "migrate", "verify", "backup", "restore-preflight", "restore", "verify-restore", "bootstrap-admin", "verify-bootstrap-admin"])
    assert.equal(descriptor.connectionBudget.total, 9)
    for (const args of [[], ["unknown"], ["describe", "--sql", "DROP DATABASE unrelated"]]) {
      const rejected = run(...args)
      assert.equal(rejected.status, 1)
      assert.equal(JSON.parse(rejected.stderr).error.code, "MAINTENANCE_COMMAND")
      assert.equal(rejected.stdout, "")
    }
    const noIdentity = run("preflight")
    assert.equal(noIdentity.status, 1)
    assert.equal(JSON.parse(noIdentity.stderr).error.code, "MAINTENANCE_RELEASE")
    const name = descriptor.database.migrations[0].name
    await writeFile(path.join(migrations, name), "CREATE DATABASE forbidden;")
    const altered = run("describe")
    assert.equal(altered.status, 1)
    assert.equal(JSON.parse(altered.stderr).error.code, "MIGRATION_SOURCE")
    await unlink(path.join(migrations, name))
    await symlink(path.join(root, "migrations", name), path.join(migrations, name))
    const linked = run("describe")
    assert.equal(linked.status, 1)
    assert.equal(JSON.parse(linked.stderr).error.code, "MIGRATION_SOURCE")
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
