import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { syntheticPdf, syntheticDocx } from './support/synthetic-documents.mjs'

if (process.env.IMAGE_PRIVATE_HTTP_ACCEPTANCE !== '1' || process.env.IMAGE_ANNOTATION_HTTP_ACCEPTANCE !== '1') throw new Error('Explicit isolated private HTTP acceptance opt-in is required')
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

test('built annotation HTTP uses real account/PG with synthetic model and memory COS only', { timeout: 90_000 }, async t => {
  cleanup()
  const bootstrap = spawnSync(process.execPath, ['--import','tsx','scripts/database/bootstrap-admin.ts'], {
    env: { ...environment, BOOTSTRAP_ADMIN_USERNAME:'http_acceptance_admin', BOOTSTRAP_ADMIN_NAME:'合成批注验收管理员', BOOTSTRAP_ADMIN_PASSWORD:password }, encoding:'utf8',
  })
  assert.equal(bootstrap.status, 0, 'Synthetic annotation admin bootstrap failed')
  const server = spawn(process.execPath, ['--require', fileURLToPath(new URL('./support/private-browser-preload.cjs', import.meta.url)), '.next/standalone/server.js'], { env:environment, stdio:['ignore','pipe','pipe'] })
  let serverLog = ''
  server.stdout.on('data', value => { serverLog = (serverLog + value).slice(-4000) })
  server.stderr.on('data', value => { serverLog = (serverLog + value).slice(-4000) })
  const exited = new Promise(resolve => server.once('exit', resolve))
  t.signal.addEventListener('abort', () => server.kill('SIGTERM'), {once:true})
  try {
    for (let attempt=0; attempt<100; attempt++) {
      try { if ((await request('/__synthetic_acceptance__/state')).ok) break } catch {}
      if (server.exitCode !== null || attempt===99) throw new Error(`Synthetic annotation server failed to start: ${serverLog}`)
      await sleep(100)
    }
    const admin = await login('http_acceptance_admin', password)
    await json('/api/admin/provider', { session:admin, method:'PUT', body:{ revision:0, settings:{ baseUrl:'https://synthetic-provider.example/v1', apiKey:'synthetic-provider-token', apiMode:'images' }, models:[], mappings:[{ id:'synthetic-mapping', name:'合成批注模型', modelId:'synthetic-actual-model' }], modelsSynced:false } })
    const created = await json('/api/admin/users', { session:admin, body:{username:'http_acceptance_user',name:'合成批注用户'} }, 201)
    const temporary = await login('http_acceptance_user', created.temporaryPassword)
    await json('/api/account/password', { session:temporary, body:{currentPassword:created.temporaryPassword,newPassword:password+'-user'} })
    const user = await login('http_acceptance_user', password+'-user'), creationId = randomUUID()
    // Exercise the built route and its actual PDF worker/DOCX dependencies before any generation.
    const beforePreview = await json('/__synthetic_acceptance__/state')
    const previewForm = (bytes, name) => {
      const data = new FormData()
      data.set('document',new File([new Uint8Array(bytes)],name,{type:name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}))
      return data
    }
    const previewCases = [
      {name:'pure-text.pdf',bytes:syntheticPdf({encoding:'flate',indirectLength:true}),inspection:'none',text:/Hello document/},
      {name:'pure-text.docx',bytes:await syntheticDocx(),inspection:'none',text:/Hello Word/},
      {name:'one-pixel.pdf',bytes:syntheticPdf({image:true}),inspection:'present',text:/Hello document/},
      {name:'one-pixel.docx',bytes:await syntheticDocx({image:true}),inspection:'present',text:/Hello Word/},
      {name:'header-image.docx',bytes:await syntheticDocx({image:true,header:true}),inspection:'present',text:/Hello Word/},
    ]
    for(const preview of previewCases) {
      const response = await request('/api/documents/preview',{session:user,form:previewForm(preview.bytes,preview.name)})
      const value = await response.json()
      assert.equal(response.status,200,JSON.stringify(value))
      assert.match(response.headers.get('cache-control'),/private.*no-store/)
      assert.ok(response.headers.get('vary')?.split(',').some(value => value.trim().toLowerCase()==='cookie'))
      assert.deepEqual(Object.keys(value),['document'])
      assert.deepEqual(Object.keys(value.document).sort(),['imageInspection','name','text'])
      assert.equal(value.document.name,preview.name)
      assert.equal(value.document.imageInspection,preview.inspection)
      assert.match(value.document.text,preview.text)
    }
    const anonymousPreview = await request('/api/documents/preview',{form:previewForm(previewCases[0].bytes,'anonymous.pdf')})
    assert.equal(anonymousPreview.status,401)
    assert.equal(Object.hasOwn(await anonymousPreview.json(),'document'),false)
    for(const key of ['imageInspection','documentText','ownerId']) {
      const data = previewForm(previewCases[0].bytes,'extra-field.pdf'); data.set(key,'none')
      const rejected = await request('/api/documents/preview',{session:user,form:data})
      assert.equal(rejected.status,400)
      assert.equal(Object.hasOwn(await rejected.json(),'document'),false)
    }
    const afterPreview = await json('/__synthetic_acceptance__/state')
    for(const key of ['modelCalls','writes','reads','objects','blockedHttps']) assert.equal(afterPreview[key],beforePreview[key],`Document previews changed ${key}`)
    const first = generation(creationId)
    const firstRun = (await json('/api/generate-image', {session:user,form:first.data})).run
    assert.equal(firstRun.status,'complete')
    assert.equal(firstRun.annotationSnapshot,null)
    const metadataPath = firstRun.imageUrl+'/metadata'
    const metadataResponse = await request(metadataPath,{session:user})
    assert.equal(metadataResponse.status,200)
    assert.match(metadataResponse.headers.get('cache-control'),/private.*no-store/)
    assert.ok(metadataResponse.headers.get('vary')?.split(',').some(value => value.trim().toLowerCase()==='cookie'))
    const metadata = await metadataResponse.json()
    assert.deepEqual(metadata,{assetId:firstRun.imageUrl.split('/').at(-1),width:320,height:240,orientation:1,pages:1})
    assert.equal((await request(metadataPath)).status,401)
    const foreign = await request(metadataPath,{session:admin}), missing = await request('/api/images/'+randomUUID()+'/metadata',{session:admin})
    assert.equal(foreign.status,404); assert.equal(missing.status,404); assert.deepEqual(await foreign.json(),await missing.json())
    const original = Buffer.from(await (await request(firstRun.imageUrl,{session:user})).arrayBuffer())
    const snapshot = {schema:1,coordinateSpace:'encoded-pixels-v1',baseVersionId:firstRun.id,image:metadata,marks:[
      {id:randomUUID(),number:1,instruction:'调整矩形区域',geometry:{type:'rectangle',x:20,y:30,width:80,height:60}},
      {id:randomUUID(),number:3,instruction:'调整圈选区域',geometry:{type:'lasso',points:[{x:150,y:80},{x:230,y:85},{x:180,y:150}]}},
      {id:randomUUID(),number:8,instruction:'调整涂抹区域',geometry:{type:'brush',points:[{x:30,y:180},{x:80,y:190}],brushWidth:14}},
    ]}
    function annotation(revision='2') {
      const edit = generation(creationId,firstRun.id)
      edit.data.set('configRevision',revision); edit.data.set('prompt',''); edit.data.set('annotationSnapshot',JSON.stringify(snapshot))
      return edit
    }
    assert.equal((await request('/api/generate-image',{session:user,form:annotation('1').data})).status,409)
    assert.equal((await json('/__synthetic_acceptance__/state')).modelCalls,1)
    const configured = await json('/api/admin/provider/annotation-capabilities',{session:admin,body:{revision:1,mappingId:'synthetic-mapping',evidenceReference:'https://synthetic.example/annotation-evidence',evidenceNote:'本测试只验证合成双输入传递',confirmed:true}})
    assert.equal(configured.revision,2)
    for (const mutate of [
      data=>data.set('image1Url','https://public.example/reference.png'),
      data=>{const wrong=structuredClone(snapshot);wrong.image.width++;data.set('annotationSnapshot',JSON.stringify(wrong))},
      data=>data.set('document',new File(['<p>含图</p><img src="anything.png">'],'brief.html',{type:'text/html'})),
    ]) {
      const invalid = annotation(); mutate(invalid.data)
      const response = await request('/api/generate-image',{session:user,form:invalid.data})
      assert.ok([202,400,409,422].includes(response.status))
      if(response.status===202)assert.equal((await response.json()).run.status,'failed')
      assert.equal((await json('/__synthetic_acceptance__/state')).modelCalls,1)
    }
    const edit = annotation()
    edit.data.set('document',new File(['保留其他区域'],'brief.txt',{type:'text/plain'}))
    const edited = (await json('/api/generate-image',{session:user,form:edit.data})).run
    assert.equal(edited.status,'complete'); assert.equal(edited.parentVersionId,firstRun.id)
    assert.deepEqual(edited.annotationSnapshot,snapshot)
    assert.doesNotMatch(JSON.stringify(edited),/bindingSha256|evidenceSha256|image-playground\/private|synthetic-provider-token/)
    const state = await json('/__synthetic_acceptance__/state')
    assert.equal(state.modelCalls,2); assert.equal(state.requests[1].imageHashes.length,2)
    assert.equal(state.requests[1].imageHashes[0],createHash('sha256').update(original).digest('hex'))
    assert.notEqual(state.requests[1].imageHashes[0],state.requests[1].imageHashes[1])
    for(const mark of snapshot.marks)assert.ok(state.requests[1].prompt.includes(mark.instruction))
    assert.equal(state.requests[1].prompt.split('保留其他区域').length-1,1)
    assert.equal((await json('/api/generate-image',{session:user,form:edit.data})).run.id,edited.id)
    const secondDevice = await login('http_acceptance_user',password+'-user')
    assert.deepEqual((await json('/api/creations/'+creationId,{session:secondDevice})).creation.versions.find(run=>run.id===edited.id).annotationSnapshot,snapshot)
    await json('/__synthetic_acceptance__/fault',{body:{failNextCompletionManifest:true}})
    const pending = annotation()
    const pendingRun = (await json('/api/generate-image',{session:user,form:pending.data},202)).run
    assert.equal(pendingRun.status,'save_pending')
    const repaired = (await json('/api/runs/'+pending.id+'/repair',{session:user,method:'POST'})).run
    assert.equal(repaired.status,'complete'); assert.deepEqual(repaired.annotationSnapshot,snapshot)
    assert.equal((await json('/__synthetic_acceptance__/state')).modelCalls,3)

    const beforeReads = (await json('/__synthetic_acceptance__/state')).reads
    await json('/__synthetic_acceptance__/fault',{body:{delayNextReadMs:1000}})
    const inFlight = request(metadataPath,{session:user})
    for(let attempt=0;attempt<50;attempt++) {
      if ((await json('/__synthetic_acceptance__/state')).reads>beforeReads) break
      if(attempt===49)throw new Error('Metadata did not enter synthetic COS')
      await sleep(5)
    }
    await json('/api/admin/users/'+created.user.id,{session:admin,body:{action:'disable'}})
    const denied = await inFlight
    assert.equal(denied.status,401)
    assert.equal(Object.hasOwn(await denied.json(),'width'),false)
    // Ordinary document generation still extracts and forwards the first usable PDF image.
    const documentGeneration = generation(randomUUID())
    documentGeneration.data.set('configRevision','2')
    documentGeneration.data.set('document',new File([new Uint8Array(syntheticPdf({image:true,imageSize:128}))],'illustrated.pdf',{type:'application/pdf'}))
    const documentRun = (await json('/api/generate-image',{session:admin,form:documentGeneration.data})).run
    assert.equal(documentRun.status,'complete')
    const final = await json('/__synthetic_acceptance__/state')
    assert.equal(final.requests.at(-1).imageHashes.length,1)
    assert.match(final.requests.at(-1).prompt,/Hello document/)
    assert.equal(final.modelCalls,4); assert.equal(final.blockedHttps,0)
    console.log(JSON.stringify({annotationHttpAcceptance:true,simulatedModelCalls:4,realModelCalls:0,realCloudWrites:0,metadataRevocation:'denied',pdfImageForwarded:true}))
  } finally {
    server.kill('SIGTERM')
    await Promise.race([exited,sleep(3000).then(()=>{if(server.exitCode===null)server.kill('SIGKILL')})])
    cleanup()
  }
})
