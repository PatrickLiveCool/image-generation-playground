import { strict as assert } from "node:assert"
import { test, after } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import ts from "typescript"

const dir = mkdtempSync(path.join(tmpdir(), "creative-generation-contract-"))
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
for (const name of ["provider-network", "relay-image", "cos-assets", "stored-generation"]) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8")
  writeFileSync(path.join(dir, `${name}.js`), compile(source).replace('require("cos-nodejs-sdk-v5")', 'require("./cos-sdk-stub")'))
}
writeFileSync(path.join(dir, "cos-sdk-stub.js"), 'module.exports = class { constructor() { throw new Error("No live COS access in contract tests") } }')
writeFileSync(path.join(dir, "next-stub.js"), 'exports.NextResponse = { json: (body, init) => Response.json(body, init) }')
const route = readFileSync(new URL("../app/api/generate-image/route.ts", import.meta.url), "utf8")
writeFileSync(path.join(dir, "generate-route.js"), compile(route).replaceAll('require("@/lib/', 'require("./').replace('require("next/server")', 'require("./next-stub")'))
const require = createRequire(import.meta.url)
const assets = require(path.join(dir, "cos-assets.js"))
const relay = require(path.join(dir, "relay-image.js"))
const network = require(path.join(dir, "provider-network.js"))
const { POST } = require(path.join(dir, "generate-route.js"))
after(() => rmSync(dir, { recursive: true, force: true }))

const config = { bucket:"test-1234567890", region:"ap-shanghai", secretId:"test-id", secretKey:"cos-secret-test", domain:"https://images.example", cdnAuthKey:"cdn-secret-test-1234", assetAccessSecret:"object-capability-secret-test-1234567890" }
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64")
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")
const baseImage = { bytes:png, mediaType:"image/png" }
const baseKey = "image-playground/runs/12345678-1234-4123-8123-123456789abc/outputs/final.png"
const baseUrl = assets.stableAssetUrl(baseKey, config)
const creationId = "11111111-1111-4111-8111-111111111111"
const clientVersionId = "22222222-2222-4222-8222-222222222222"
const parentVersionId = "gen-1700000000000-legacy-v1"

function form(lineage = true, base = true) {
  const result = new FormData()
  for (const [name,value] of Object.entries({baseUrl:"https://relay.example/v1",apiKey:"upstream-secret-test",apiMode:"images",selectedModel:"private-model",prompt:"只把标题改为秋日山行",aspectRatio:"square",quality:"auto",mode:"text-to-image"})) result.set(name,value)
  if (lineage) for (const [name,value] of Object.entries({creationId,clientVersionId,parentVersionId,version:"3"})) result.set(name,value)
  if (base) result.set("baseImageUrl",baseUrl)
  return result
}
const request = (body: FormData) => new Request("https://app.example/api/generate-image", {method:"POST",body})
function recordingStore() {
  const writes: Array<{key:string;bytes:Buffer;contentType:string}> = []
  const reads: string[] = []
  return {
    config, writes, reads,
    async put(key:string,bytes:Uint8Array,contentType:string) { writes.push({key,bytes:Buffer.from(bytes),contentType}) },
    async getImage(key:string) { reads.push(key); return baseImage },
    assetUrl: (key:string) => assets.stableAssetUrl(key,config),
  }
}

function latestManifest(store: ReturnType<typeof recordingStore>) {
  return JSON.parse(store.writes.filter(write => write.key.endsWith("manifest.json")).at(-1)!.bytes.toString())
}

test("editing an old version sends its bytes first and preserves lineage without replaying earlier prompts", async context => {
  const store=recordingStore()
  context.mock.method(assets,"createCosStore",()=>store)
  let calls=0
  context.mock.method(relay,"generateRelayImage",async (_settings:unknown,input:any) => {
    calls++
    assert.deepEqual(Buffer.from(input.images[0].bytes),png)
    assert.deepEqual(Buffer.from(input.images[1].bytes),gif)
    assert.match(input.prompt,/以第一张图片为编辑基准/)
    assert.equal(input.prompt.endsWith("只把标题改为秋日山行"),true)
    assert.equal(input.prompt.match(/只把标题改为秋日山行/g)?.length,1)
    assert.equal("lineage" in input,false)
    assert.equal(store.writes.filter(write=>write.key.includes("/inputs/")).length,2)
    return baseImage
  })
  const body=form()
  body.set("image1",new File([gif],"reference.gif",{type:"image/gif"}))
  const response=await POST(request(body))
  assert.equal(response.status,200)
  const result=await response.json()
  assert.equal(calls,1)
  assert.deepEqual(store.reads,[baseKey])
  assert.deepEqual({creationId:result.creationId,clientVersionId:result.clientVersionId,parentVersionId:result.parentVersionId,version:result.version},{creationId,clientVersionId,parentVersionId,version:3})
  const manifest=latestManifest(store)
  assert.equal(manifest.mode,"image-editing")
  assert.equal(manifest.status,"complete")
  assert.equal(manifest.prompt.text,"只把标题改为秋日山行")
  assert.equal(manifest.prompt.sha256,createHash("sha256").update(manifest.prompt.text).digest("hex"))
  assert.equal(manifest.prompt.length,manifest.prompt.text.length)
  assert.equal(manifest.baseInputKey,manifest.inputs[0].key)
  assert.deepEqual(manifest.lineage,{creationId,clientVersionId,parentVersionId,version:3})
  for(const secret of ["upstream-secret-test",config.secretKey,config.assetAccessSecret,baseUrl]) assert.equal(JSON.stringify(manifest).includes(secret),false)
})

test("partial or incoherent lineage fails before storage and any model request", async context => {
  let stores=0,calls=0
  context.mock.method(assets,"createCosStore",()=>{stores++;return recordingStore()})
  context.mock.method(relay,"generateRelayImage",async()=>{calls++;return baseImage})
  const cases: FormData[]=[]
  const missingBase=form(true,false);cases.push(missingBase)
  const missingParent=form();missingParent.delete("parentVersionId");cases.push(missingParent)
  const partial=form(false,false);partial.set("creationId",creationId);cases.push(partial)
  const badCreation=form();badCreation.set("creationId","not-a-uuid");cases.push(badCreation)
  const badVersion=form();badVersion.set("version","0");cases.push(badVersion)
  const unsafeVersion=form();unsafeVersion.set("version","9007199254740992");cases.push(unsafeVersion)
  const selfParent=form();selfParent.set("parentVersionId",clientVersionId);cases.push(selfParent)
  const emptyBase=form(false,false);emptyBase.set("baseImageUrl","");cases.push(emptyBase)
  for (const body of cases) assert.equal((await POST(request(body))).status,400)
  assert.equal(stores,0)
  assert.equal(calls,0)
})

test("invalid or missing owned base never falls back to a fresh generation or external fetch", async context => {
  const store=recordingStore()
  let calls=0,externalReads=0
  context.mock.method(assets,"createCosStore",()=>store)
  context.mock.method(relay,"generateRelayImage",async()=>{calls++;return baseImage})
  context.mock.method(relay,"readImageSource",async()=>{externalReads++;return baseImage})
  const bad=form();bad.set("baseImageUrl",baseUrl.replace(/access=.*/,"access=invalid"))
  assert.equal((await POST(request(bad))).status,403)
  assert.equal(store.reads.length,0)
  assert.equal(store.writes.length,0)
  context.mock.method(store,"getImage",async()=>{throw new network.ProviderError("无法读取对象存储中的图片。",502)})
  assert.equal((await POST(request(form()))).status,502)
  assert.equal(store.writes.length,0)
  assert.equal(calls,0)
  assert.equal(externalReads,0)
})

test("a third image is rejected before reading the base or creating a model request", async context => {
  let stores=0,calls=0
  context.mock.method(assets,"createCosStore",()=>{stores++;return recordingStore()})
  context.mock.method(relay,"generateRelayImage",async()=>{calls++;return baseImage})
  const body=form()
  body.set("image1",new File([gif],"reference.gif",{type:"image/gif"}))
  body.set("image2",new File([png],"reference.png",{type:"image/png"}))
  assert.equal((await POST(request(body))).status,400)
  assert.equal(stores,0)
  assert.equal(calls,0)
})

test("old clients retain standalone generation and two-reference editing compatibility", async context => {
  for(const editing of [false,true]) {
    const store=recordingStore()
    context.mock.method(assets,"createCosStore",()=>store)
    context.mock.method(relay,"generateRelayImage",async(_settings:unknown,input:any)=>{
      assert.equal(input.images.length,editing?2:0)
      assert.equal(input.prompt,"只把标题改为秋日山行")
      return baseImage
    })
    const body=form(false,false)
    if(editing) {
      body.set("mode","image-editing")
      body.set("image1",new File([png],"one.png",{type:"image/png"}))
      body.set("image2",new File([gif],"two.gif",{type:"image/gif"}))
    }
    const response=await POST(request(body))
    assert.equal(response.status,200)
    const result=await response.json()
    assert.match(result.url,/^\/api\/assets\//)
    assert.equal(result.creationId,undefined)
    assert.equal(latestManifest(store).lineage,undefined)
  }
})

test("first creation version is valid without a parent while legacy HTTPS bases remain editable", async context => {
  const store=recordingStore()
  context.mock.method(assets,"createCosStore",()=>store)
  let reads=0
  context.mock.method(relay,"readImageSource",async(url:string)=>{reads++;assert.equal(url,"https://legacy.example/result.png");return baseImage})
  context.mock.method(relay,"generateRelayImage",async()=>baseImage)
  const first=form(true,false)
  first.delete("parentVersionId");first.set("version","1")
  assert.equal((await POST(request(first))).status,200)
  assert.equal(latestManifest(store).lineage.parentVersionId,null)
  const legacy=form();legacy.set("baseImageUrl","https://legacy.example/result.png")
  assert.equal((await POST(request(legacy))).status,200)
  assert.equal(reads,1)
  assert.equal(store.reads.length,0)
})
