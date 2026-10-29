import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

if (process.env.IMAGE_PRIVATE_HTTP_ACCEPTANCE !== '1') throw new Error('Explicit isolated private HTTP acceptance opt-in is required')
const base = 'http://127.0.0.1:3108', origin = 'https://acceptance.image.test'
const password = 'Synthetic-private-http-password-20261029'
const environment = {
  ...process.env, NODE_ENV: 'test', PORT: '3108', HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1',
  IMAGE_DATABASE_TARGET: 'local', IMAGE_DATABASE_URL: 'postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image',
  BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: 'synthetic-private-http-auth-secret-20261029-only', PROVIDER_CONFIG_KEY: Buffer.alloc(32, 61).toString('base64'),
  COS_BUCKET: 'synthetic-private-1234567890', COS_REGION: 'ap-shanghai', COS_SECRET_ID: 'synthetic-cos-secret-id', COS_SECRET_KEY: 'synthetic-cos-secret-key',
}
const cleanupSource = `
const {getDatabase,closeDatabase}=require('./lib/database.ts');
const {assertAccountTestFixture}=require('./scripts/database/test-fixture.ts');
(async()=>{
  const db=await getDatabase();
  await assertAccountTestFixture(db);
  const names=['http_acceptance_admin','http_acceptance_user'];
  const ids='SELECT id FROM app."user" WHERE username=ANY($1::text[])';
  await db.query('DELETE FROM app.provider_config_audit WHERE "actorId" IN ('+ids+')',[names]);
  await db.query('DELETE FROM app.provider_settings WHERE "updatedBy" IN ('+ids+')',[names]);
  await db.query('DELETE FROM app.account_audit WHERE "actorId" IN ('+ids+') OR "subjectId" IN ('+ids+')',[names]);
  await db.query('DELETE FROM app."user" WHERE username=ANY($1::text[])',[names]);
  await closeDatabase();
})()`
function cleanup() {
  const result = spawnSync(process.execPath, ['--import','tsx','-e',cleanupSource], { env: environment, encoding: 'utf8' })
  assert.equal(result.status, 0, 'Fixed local synthetic fixture cleanup failed')
}
const cookies = response => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
async function request(path, { session, body, method, form } = {}) {
  return fetch(base + path, { method: method ?? (body || form ? 'POST' : 'GET'), redirect: 'manual', signal:AbortSignal.timeout(15_000),
    headers: { Origin: origin, ...(session ? { Cookie: session } : {}), ...(body ? { 'Content-Type':'application/json' } : {}) },
    ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => { throw new Error(`Synthetic HTTP request failed: ${path}`) })
}
async function json(path, options, expected = 200) {
  const response = await request(path, options)
  const value = await response.json()
  assert.equal(response.status, expected, JSON.stringify(value))
  return value
}
async function login(username, secret) {
  const response = await request('/api/auth/sign-in/username', { body: { username, password: secret } })
  assert.equal(response.status, 200, await response.clone().text())
  return cookies(response)
}
function generation(creationId, parentVersionId) {
  const data = new FormData(), id = randomUUID()
  for (const [key,value] of Object.entries({ creationId, clientRequestId:id, mappingId:'synthetic-mapping', configRevision:'1', prompt:'合成验收：保留画面主体，修改背景', aspectRatio:'square', quality:'auto', mode:parentVersionId?'image-editing':'text-to-image' })) data.set(key,value)
  if (parentVersionId) data.set('parentVersionId', parentVersionId)
  return { id, data }
}

test('built private HTTP flow uses real auth/PG and only memory COS + synthetic model', { timeout: 60_000 }, async t => {
  cleanup()
  const bootstrap = spawnSync(process.execPath, ['--import','tsx','scripts/database/bootstrap-admin.ts'], {
    env: { ...environment, BOOTSTRAP_ADMIN_USERNAME:'http_acceptance_admin', BOOTSTRAP_ADMIN_NAME:'合成验收管理员', BOOTSTRAP_ADMIN_PASSWORD:password }, encoding:'utf8',
  })
  assert.equal(bootstrap.status, 0, 'Synthetic admin bootstrap failed')
  const server = spawn(process.execPath, ['--require', fileURLToPath(new URL('./support/private-browser-preload.cjs', import.meta.url)), '.next/standalone/server.js'], { env:environment, stdio:['ignore','pipe','pipe'] })
  let serverLog = ''
  server.stdout.on('data', value => { serverLog = (serverLog + value).slice(-4000) })
  server.stderr.on('data', value => { serverLog = (serverLog + value).slice(-4000) })
  const exited = new Promise(resolve => server.once('exit', resolve))
  t.signal.addEventListener('abort', () => server.kill('SIGTERM'), {once:true})
  try {
    for (let attempt=0; attempt<100; attempt++) {
      try { if ((await request('/__synthetic_acceptance__/state')).ok) break } catch {}
      if (server.exitCode !== null || attempt===99) throw new Error(`Synthetic server failed to start: ${serverLog}`)
      await sleep(100)
    }
    assert.equal((await request('/api/creations')).status, 401)
    const admin = await login('http_acceptance_admin', password)
    await json('/api/admin/provider', { session:admin, method:'PUT', body:{ revision:0, settings:{ baseUrl:'https://synthetic-provider.example/v1', apiKey:'synthetic-provider-token', apiMode:'images' }, models:[], mappings:[{ id:'synthetic-mapping', name:'合成图片模型', modelId:'synthetic-actual-model' }], modelsSynced:false } })
    const created = await json('/api/admin/users', { session:admin, body:{username:'http_acceptance_user',name:'合成验收用户'} }, 201)
    const temporary = await login('http_acceptance_user', created.temporaryPassword)
    await json('/api/account/password', { session:temporary, body:{currentPassword:created.temporaryPassword,newPassword:password+'-user'} })
    const user = await login('http_acceptance_user', password+'-user')
    assert.deepEqual((await json('/api/creations',{session:user})).creations, [])
    const creationId = randomUUID()
    await json('/api/creations', {session:user,body:{id:creationId,title:'跨设备合成创作'}}, 201)
    const first = generation(creationId)
    const firstRun = (await json('/api/generate-image', {session:user,form:first.data})).run
    assert.equal(firstRun.status,'complete'); assert.equal(firstRun.version,1)
    assert.match(firstRun.imageUrl,/^\/api\/images\/[0-9a-f-]{36}$/)
    assert.doesNotMatch(JSON.stringify(firstRun),/synthetic-provider-token|synthetic-actual-model|image-playground\/private|synthetic-provider\.example|access=/)
    assert.equal((await json('/api/generate-image',{session:user,form:first.data})).run.id,firstRun.id)
    assert.equal((await json('/__synthetic_acceptance__/state')).modelCalls,1)

    const image = await request(firstRun.imageUrl,{session:user})
    assert.equal(image.status,200); assert.equal(image.headers.get('content-type'),'image/png')
    for (const header of ['cache-control','vary','x-content-type-options','cross-origin-resource-policy']) assert.ok(image.headers.get(header))
    assert.match(image.headers.get('cache-control'),/private.*no-store/)
    assert.equal(image.headers.get('location'),null)
    const bytes = Buffer.from(await image.arrayBuffer())
    assert.equal(bytes.readUInt32BE(16),320); assert.equal(bytes.readUInt32BE(20),240)
    const foreign = await request(firstRun.imageUrl,{session:admin}), missing = await request('/api/images/'+randomUUID(),{session:admin})
    assert.equal(foreign.status,404); assert.equal(missing.status,404); assert.deepEqual(await foreign.json(),await missing.json())
    assert.equal((await request(firstRun.imageUrl)).status,401)
    assert.equal((await request('/api/assets/old?access=old')).status,410)
    const secondDevice = await login('http_acceptance_user',password+'-user')
    assert.equal((await json('/api/creations',{session:secondDevice})).creations[0].versions[0].id,firstRun.id)

    const edit = generation(creationId,firstRun.id)
    edit.data.set('document',new File(['文档内容只出现一次'],'合成说明.txt',{type:'text/plain'}))
    const editRun = (await json('/api/generate-image',{session:user,form:edit.data})).run
    assert.equal(editRun.version,2); assert.equal(editRun.parentVersionId,firstRun.id)
    const afterEdit = await json('/__synthetic_acceptance__/state')
    assert.equal(afterEdit.requests[1].imageHashes[0],createHash('sha256').update(bytes).digest('hex'))
    assert.equal(afterEdit.requests[1].prompt.split('文档内容只出现一次').length-1,1)
    const documentPath = '/api/documents/'+editRun.document.assetId
    const document = await request(documentPath,{session:secondDevice})
    assert.equal(document.status,200); assert.match(document.headers.get('content-disposition'),/^attachment;/)
    assert.equal(document.headers.get('x-content-type-options'),'nosniff')
    assert.equal(await document.text(),'文档内容只出现一次')
    assert.equal((await request(documentPath,{session:admin})).status,404)
    assert.equal((await request('/api/images/'+editRun.document.assetId,{session:user})).status,404)

    await json('/__synthetic_acceptance__/fault',{body:{failNextCompletionManifest:true}})
    const pending = generation(creationId,firstRun.id)
    const pendingRun = (await json('/api/generate-image',{session:user,form:pending.data},202)).run
    assert.equal(pendingRun.status,'save_pending')
    assert.equal((await json('/api/runs/'+pending.id,{session:user})).run.status,'save_pending')
    const repaired = (await json('/api/runs/'+pending.id+'/repair',{session:user,method:'POST'})).run
    assert.equal(repaired.status,'complete'); assert.equal(repaired.version,3)
    assert.deepEqual((await json('/api/runs/'+pending.id+'/repair',{session:user,method:'POST'})).run,repaired)
    assert.equal((await json('/__synthetic_acceptance__/state')).modelCalls,3)
    const forbidden = generation(creationId); forbidden.data.set('image1Url','https://acceptance.image.test'+firstRun.imageUrl)
    assert.equal((await request('/api/generate-image',{session:user,form:forbidden.data})).status,400)
    const unavailableBase = generation(creationId,randomUUID())
    assert.equal((await request('/api/generate-image',{session:user,form:unavailableBase.data})).status,409)
    assert.equal((await json('/__synthetic_acceptance__/state')).modelCalls,3)
    const fresh = (await json('/api/creations/'+creationId,{session:user})).creation
    assert.equal(fresh.versions.length,3)
    assert.equal((await json('/api/creations/'+creationId,{session:user,method:'PATCH',body:{revision:fresh.revision,title:'已核对私有创作'}})).creation.title,'已核对私有创作')

    // 在COS读进行中撤销账号，响应前二次认证必须拒绝交付已经读取的图片字节。
    const beforeReads = (await json('/__synthetic_acceptance__/state')).reads
    await json('/__synthetic_acceptance__/fault',{body:{delayNextReadMs:1000}})
    const inFlight = request(firstRun.imageUrl,{session:user})
    for(let attempt=0;attempt<50;attempt++) {
      if ((await json('/__synthetic_acceptance__/state')).reads>beforeReads) break
      if(attempt===49)throw new Error('Image read did not enter synthetic COS')
      await sleep(5)
    }
    await json('/api/admin/users/'+created.user.id,{session:admin,body:{action:'disable'}})
    const denied = await inFlight
    assert.equal(denied.status,401); assert.equal(denied.headers.get('content-type')?.startsWith('image/'),false)
    const finalState = await json('/__synthetic_acceptance__/state')
    assert.equal(finalState.modelCalls,3); assert.equal(finalState.faults,1); assert.equal(finalState.blockedHttps,0)
    console.log(JSON.stringify({privateHttpAcceptance:true,simulatedModelCalls:finalState.modelCalls,memoryCosWrites:finalState.writes,realModelCalls:0,realCloudWrites:0,revocationDuringAssetRead:'denied'}))
  } finally {
    server.kill('SIGTERM')
    await Promise.race([exited,sleep(3000).then(()=>{if(server.exitCode===null)server.kill('SIGKILL')})])
    cleanup()
  }
})
