import { build, version as esbuildVersion } from 'esbuild'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isBuiltin } from 'node:module'
import path from 'node:path'

const project = fileURLToPath(new URL('../../', import.meta.url))
const next = path.join(project, '.next'), output = path.join(next, 'maintenance')
const assert = (condition, message) => { if (!condition) throw new Error(message) }
async function trusted(filename, directory = false) {
  const stat = await lstat(filename)
  assert(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) && !(stat.mode & 0o022) &&
    (stat.uid === 0 || stat.uid === process.getuid?.()), 'Maintenance source is not a trusted project file')
}

async function main() {
  assert(process.argv.length === 2, 'Maintenance builder accepts no output path or extra arguments')
  assert(process.versions.node.startsWith('22.') && esbuildVersion === '0.27.7', 'Maintenance build requires pinned Node 22 and esbuild 0.27.7')
  await trusted(project, true)
  await mkdir(next, { recursive: true })
  await trusted(next, true)
  const scratch = await mkdtemp(path.join(next, 'maintenance-build-'))
  const staged = path.join(scratch, 'maintenance'), previous = path.join(scratch, 'previous')
  let displaced = false, preserveRecovery = false
  try {
    await mkdir(path.join(staged, 'migrations'), { recursive: true })
    const sqlRoot = path.join(project, 'migrations')
    await trusted(sqlRoot, true)
    for (const name of await readdir(sqlRoot)) {
      assert(/^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/.test(name), 'Unexpected migration source')
      const source = path.join(sqlRoot, name)
      await trusted(source)
      const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        assert(stat.isFile() && stat.nlink === 1 && stat.size <= 1_048_576 && !(stat.mode & 0o022), 'Invalid migration source')
        const destination = await open(path.join(staged, 'migrations', name), 'wx', 0o644)
        try { await destination.writeFile(await file.readFile()) } finally { await destination.close() }
      } finally { await file.close() }
    }
    const built = await build({
      absWorkingDir: project, entryPoints: ['scripts/database/cli.ts'], outfile: path.join(staged, 'cli.mjs'),
      bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['pg'], metafile: true,
      define: { __IMAGE_MAINTENANCE_BUNDLE__: 'true' }, logLevel: 'silent', sourcemap: false,
    })
    assert(Object.values(built.metafile.outputs).every(output => output.imports.every(entry => !entry.external || entry.path === 'pg' || isBuiltin(entry.path))),
      'Maintenance runtime contains an untraced external dependency')
    // 实际Node运行同一loader校验完整审核哈希集，也验证外置pg可以被解析。
    const descriptor = JSON.parse(execFileSync(process.execPath, [path.join(staged, 'cli.mjs'), 'describe'], {
      cwd: project, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    }))
    assert(descriptor.application === 'qintopia-image' && descriptor.protocol === 'account-private-v1', 'Unexpected maintenance descriptor')
    try { await rename(output, previous); displaced = true } catch (error) { if (error.code !== 'ENOENT') throw error }
    try { await rename(staged, output) } catch (error) {
      if (displaced) {
        preserveRecovery = true
        await rename(previous, output)
        preserveRecovery = false
      }
      displaced = false
      throw error
    }
    console.log(JSON.stringify({ maintenanceBundle: 'built', application: descriptor.application, migrations: descriptor.database.migrations.length,
      commands: descriptor.commands, connectionBudget: descriptor.connectionBudget }))
  } finally { if (!preserveRecovery) await rm(scratch, { recursive: true, force: true }) }
}

main().catch(() => { console.error('维护包构建失败；原有已完成输出未被不完整构建替换。'); process.exitCode = 1 })
