import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

import { test } from 'node:test'

if (process.env.IMAGE_ACCOUNT_HTTP_INTEGRATION !== '1') throw new Error('Explicit isolated HTTP acceptance opt-in is required')

test('built Next server enforces account routes and secure session cookies', { timeout: 30_000 }, async () => {
const base='http://127.0.0.1:3107'
const origin='https://acceptance.image.test'
const env={...process.env,PORT:'3107',HOSTNAME:'127.0.0.1',IMAGE_DATABASE_TARGET:'local',IMAGE_DATABASE_URL:'postgresql://qintopia_image_app:synthetic-local-runtime-only@127.0.0.1:32768/qintopia_image',BETTER_AUTH_URL:origin,BETTER_AUTH_SECRET:randomBytes(48).toString('hex'),PROVIDER_CONFIG_KEY:randomBytes(32).toString('base64'),NEXT_TELEMETRY_DISABLED:'1'}
const password=randomBytes(24).toString('base64url')
const cleanupBefore=spawnSync(process.execPath,['--import','tsx','-e',`const {getDatabase,closeDatabase}=require('./lib/database.ts'); const {assertAccountTestFixture}=require('./scripts/database/test-fixture.ts'); (async()=>{const db=await getDatabase();await assertAccountTestFixture(db);await db.query('DELETE FROM app.provider_config_audit WHERE \"actorId\" IN (SELECT id FROM app.\"user\" WHERE username=ANY($1::text[]))',[['http_acceptance_admin','http_acceptance_user']]);await db.query('DELETE FROM app.provider_settings WHERE \"updatedBy\" IN (SELECT id FROM app.\"user\" WHERE username=ANY($1::text[]))',[['http_acceptance_admin','http_acceptance_user']]);await db.query('DELETE FROM app.account_audit WHERE "subjectId" IN (SELECT id FROM app."user" WHERE username=ANY($1::text[]))',[['http_acceptance_admin','http_acceptance_user']]);await db.query('DELETE FROM app."user" WHERE username=ANY($1::text[])',[['http_acceptance_admin','http_acceptance_user']]);await db.query('DELETE FROM app."rateLimit"');await closeDatabase()})()`],{env,encoding:'utf8'})
assert.equal(cleanupBefore.status,0,'synthetic fixture cleanup')
const bootstrap=spawnSync(process.execPath,['--import','tsx','scripts/database/bootstrap-admin.ts'],{env:{...env,BOOTSTRAP_ADMIN_USERNAME:'http_acceptance_admin',BOOTSTRAP_ADMIN_NAME:'HTTP合成管理员',BOOTSTRAP_ADMIN_PASSWORD:password},encoding:'utf8'})
assert.equal(bootstrap.status,0,bootstrap.stderr)
const server=spawn(process.execPath,['.next/standalone/server.js'],{env,stdio:['ignore','pipe','pipe']})
const exited = new Promise(resolve => server.once('exit', resolve))
server.stdout.resume(); server.stderr.resume()
const cookie=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
async function request(path,{body,session,method}={}){return fetch(base+path,{method:method??(body?'POST':'GET'),headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual'})}
let checks=0
try{
 for(let i=0;i<100;i++){
  try{if((await fetch(base+'/login')).ok)break}catch{}
  if(i===99)throw new Error('Local server not ready')
  await sleep(100)
 }
 for(const path of ['/','/login','/change-password']){const r=await request(path);assert.equal(r.status,200);checks++}
 assert.equal((await request('/api/admin/users')).status,401);checks++
 const login=await request('/api/auth/sign-in/username',{body:{username:'http_acceptance_admin',password}})
 assert.equal(login.status,200,await login.clone().text());const adminCookie=cookie(login)
 assert.match(login.headers.get('set-cookie'),/secure/i);assert.match(login.headers.get('cache-control'),/no-store/);checks++
 const adminPage=await request('/admin/users',{session:adminCookie});assert.equal(adminPage.status,200);assert.match(await adminPage.text(),/账号管理/);checks++
 const initialConfig=await request('/api/admin/provider',{session:adminCookie});assert.equal(initialConfig.status,200);assert.equal((await initialConfig.json()).revision,0);checks++
 const configured=await request('/api/admin/provider',{session:adminCookie,method:'PUT',body:{revision:0,settings:{baseUrl:'https://synthetic-provider.example/v1',apiKey:'synthetic-provider-token',apiMode:'images'},models:[],mappings:[{id:'synthetic-mapping',name:'合成显示名称',modelId:'synthetic-actual-model'}],modelsSynced:false}})
 assert.equal(configured.status,200);const provider=await configured.json();assert.equal(provider.settings.apiKey,'');assert.equal(provider.secretConfigured,true);checks++
 const catalog=await request('/api/models',{session:adminCookie});assert.equal(catalog.status,200);const publicCatalog=await catalog.json();assert.equal(publicCatalog.mappings[0].name,'合成显示名称');assert.equal(JSON.stringify(publicCatalog).includes('synthetic-provider-token'),false);assert.equal(JSON.stringify(publicCatalog).includes('synthetic-actual-model'),false);assert.equal(JSON.stringify(publicCatalog).includes('synthetic-provider.example'),false);checks++
 const modelsPage=await request('/admin/models',{session:adminCookie});assert.equal(modelsPage.status,200);assert.match(await modelsPage.text(),/模型设置/);checks++
 const created=await request('/api/admin/users',{session:adminCookie,body:{username:'http_acceptance_user',name:'HTTP合成用户'}})
 assert.equal(created.status,201,'create-user HTTP status');const user=await created.json();checks++
 const temp=await request('/api/auth/sign-in/username',{body:{username:'http_acceptance_user',password:user.temporaryPassword}})
 assert.equal(temp.status,200);const tempCookie=cookie(temp);checks++
 assert.equal((await request('/api/generate-image',{session:tempCookie,body:{}})).status,403);checks++
 assert.equal((await request('/api/provider/models',{session:tempCookie,body:{}})).status,403);checks++
 const changed=await request('/api/account/password',{session:tempCookie,body:{currentPassword:user.temporaryPassword,newPassword:password+'-user'}})
 assert.equal(changed.status,200,await changed.clone().text());checks++
 assert.equal((await (await request('/api/account/session',{session:tempCookie})).json()).user,null);checks++
 const normal=await request('/api/auth/sign-in/username',{body:{username:'http_acceptance_user',password:password+'-user'}});assert.equal(normal.status,200);const normalCookie=cookie(normal);checks++
 assert.equal((await request('/api/provider/models',{session:normalCookie,body:{}})).status,403);checks++
 assert.equal((await request('/api/admin/users',{session:normalCookie})).status,403);checks++
 assert.equal((await request('/api/assets/old-test?access=old')).status,410);checks++
 assert.equal((await request('/api/auth/admin/impersonate-user',{session:adminCookie,body:{}})).status,404);checks++
 const disabled=await request('/api/admin/users/'+user.user.id,{session:adminCookie,body:{action:'disable'}});assert.equal(disabled.status,200);checks++
 assert.equal((await (await request('/api/account/session',{session:normalCookie})).json()).user,null);checks++
 assert.equal((await request('/api/auth/sign-out',{session:adminCookie,body:{}})).status,200);checks++
 console.log(JSON.stringify({checks,passed:true,browser:false,modelCalls:0,cloudWrites:0}))
}catch(error){console.error('HTTP acceptance failed:',error.message);throw error}finally{
 server.kill('SIGTERM')
 await Promise.race([exited, sleep(3_000).then(() => { if (server.exitCode === null) server.kill('SIGKILL') })])
 const cleanup=spawnSync(process.execPath,['--import','tsx','-e',`const {getDatabase,closeDatabase}=require('./lib/database.ts'); const {assertAccountTestFixture}=require('./scripts/database/test-fixture.ts'); (async()=>{const db=await getDatabase();await assertAccountTestFixture(db);await db.query('DELETE FROM app.provider_config_audit WHERE \"actorId\" IN (SELECT id FROM app.\"user\" WHERE username=ANY($1::text[]))',[['http_acceptance_admin','http_acceptance_user']]);await db.query('DELETE FROM app.provider_settings WHERE \"updatedBy\" IN (SELECT id FROM app.\"user\" WHERE username=ANY($1::text[]))',[['http_acceptance_admin','http_acceptance_user']]);await db.query('DELETE FROM app.account_audit WHERE "subjectId" IN (SELECT id FROM app."user" WHERE username=ANY($1::text[]))', [['http_acceptance_admin','http_acceptance_user']]);await db.query('DELETE FROM app."user" WHERE username=ANY($1::text[])',[['http_acceptance_admin','http_acceptance_user']]);await db.query('DELETE FROM app."rateLimit"');await closeDatabase()})()`],{env,encoding:'utf8'})
 assert.equal(cleanup.status,0,cleanup.stderr)
}

})
