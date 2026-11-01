import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const LOCAL_FIXTURE_CONTAINER = 'image-playground-acceptance-pg'
const TASK = '01a17dff-bdc4-7712-9e0a-e553ae2240d6'
// 专用于此可丢弃夹具的固定标识，不是凭据；运行账户只读数据库 COMMENT。
export const LOCAL_FIXTURE_ID = 'a4f57e02-969d-41d3-8d5a-03b74a6949d2'
export const LOCAL_FIXTURE_IDENTITY_SQL = `SELECT json_build_object(
  'database', current_database(), 'databaseOid', d.oid::text,
  'serverStartedAt', extract(epoch FROM pg_postmaster_start_time())::text,
  'serverVersion', current_setting('server_version_num'),
  'marker', shobj_description(d.oid, 'pg_database')) AS fixture
FROM pg_database d WHERE d.datname = current_database()`

export function localFixtureMarker(containerId) {
  if (!/^[a-f0-9]{64}$/.test(containerId ?? '')) throw new Error('本地数据库夹具 ID 无效。')
  return JSON.stringify({ fixture: LOCAL_FIXTURE_ID, purpose: 'synthetic-account-tests-only', containerId })
}

// 导出纯校验，测试不必访问 Docker 或真实数据库。
export function assertLocalFixture(container) {
  const bindings = container?.NetworkSettings?.Ports?.['5432/tcp']
  if (!/^[a-f0-9]{64}$/.test(container?.Id ?? '') || container?.Name !== `/${LOCAL_FIXTURE_CONTAINER}` ||
      container?.Config?.Labels?.['codex.project'] !== 'image-generation-playground' ||
      container?.Config?.Labels?.['codex.task'] !== TASK ||
      container?.State?.Running !== true ||
      !Array.isArray(bindings) || bindings.length !== 1 ||
      bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== '32768') {
    throw new Error('本地数据库夹具身份或回环端口不匹配，未执行初始化。')
  }
}

export function inspectLocalFixture() {
  const inspected = JSON.parse(execFileSync('docker', ['inspect', LOCAL_FIXTURE_CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }))
  if (inspected.length !== 1) throw new Error('本地数据库夹具不唯一。')
  assertLocalFixture(inspected[0])
  return inspected[0]
}

export function readLocalFixtureIdentity(containerId) {
  // 读取已核验 ID 内部的服务器身份，不能将宿主回环端口当作容器证明。
  localFixtureMarker(containerId)
  return JSON.parse(execFileSync('docker', ['exec', containerId, 'psql', '-X', '-U', 'image_test_root', '-d', 'qintopia_image', '-At', '-v', 'ON_ERROR_STOP=1', '-c', LOCAL_FIXTURE_IDENTITY_SQL], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  }))
}

export function bootstrapLocalFixture() {
  const container = inspectLocalFixture()
  const marker = localFixtureMarker(container.Id)
  const existing = execFileSync('docker', ['exec', container.Id, 'psql', '-X', '-U', 'image_test_root', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'qintopia_image'"], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  }).trim()
  if (existing && existing !== marker) throw new Error('本地数据库已有未知夹具标记，未执行初始化。')
  const sql = readFileSync(new URL('./bootstrap-local.sql', import.meta.url), 'utf8')
  // stdin 承载 SQL；仅调用已经核验的容器 ID，消除名称在检查后被替换的窗口。
  execFileSync('docker', ['exec', '-i', container.Id, 'psql', '-X', '-U', 'image_test_root', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', `fixture_marker=${marker}`], {
    input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000,
  })
  if (readLocalFixtureIdentity(container.Id).marker !== marker) throw new Error('本地数据库夹具标记回读不匹配。')
  return '本地隔离数据库与受限身份已准备；既有角色密码和业务数据未重置。'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(bootstrapLocalFixture()) }
  catch { console.error('本地数据库初始化失败；请核对指定夹具状态，未输出连接串或数据库错误详情。'); process.exitCode = 1 }
}
