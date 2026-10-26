import { strict as assert } from "node:assert"
import { test, after } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import ts from "typescript"

const dir = mkdtempSync(path.join(tmpdir(), "cos-storage-contract-"))
for (const name of ["provider-network", "relay-image", "cos-assets", "stored-generation"]) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8")
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  // Tests inject a COS client. The stub prevents SDK construction or live calls.
  writeFileSync(path.join(dir, `${name}.js`), output.replace('require("cos-nodejs-sdk-v5")', 'require("./cos-sdk-stub")'))
}
writeFileSync(path.join(dir, "cos-sdk-stub.js"), 'module.exports = class { constructor() { throw new Error("Tests must inject a COS client") } }')
const routeSource = readFileSync(new URL("../app/api/assets/[...key]/route.ts", import.meta.url), "utf8")
writeFileSync(path.join(dir, "asset-route.js"), ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll('require("@/lib/', 'require("./'))
const require = createRequire(import.meta.url)
const assets = require(path.join(dir, "cos-assets.js"))
const { generateAndStore } = require(path.join(dir, "stored-generation.js"))
const { GET } = require(path.join(dir, "asset-route.js"))
after(() => rmSync(dir, { recursive: true, force: true }))
const runId = "12345678-1234-4123-8123-123456789abc"
const key = `image-playground/runs/${runId}/outputs/final.png`
const config = { bucket: "test-bucket-1234567890", region: "ap-shanghai", secretId: "test-id", secretKey: "test-cos-secret", domain: "https://images.example", cdnAuthKey: "test-cdn-secret-12345678", assetAccessSecret: "test-capability-secret-12345678901234567890" }
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64")
const image = { bytes: png, mediaType: "image/png" }
const settings = { baseUrl: "https://relay.example/v1", apiKey: "test-upstream-secret", apiMode: "images" }
const input = { model: "private-image-alias", prompt: "private test prompt", aspectRatio: "square", quality: "auto", images: [image, image] }

function recordingStore(fail?: (key: string, body: Uint8Array) => boolean) {
  const writes: { key: string; body: Uint8Array; contentType: string }[] = []
  return {
    writes, config,
    async put(key: string, body: Uint8Array, contentType: string) {
      if (fail?.(key, body)) throw new Error("simulated storage failure")
      writes.push({ key, body: Buffer.from(body), contentType })
    },
    async getImage() { return image },
    assetUrl(key: string) { return assets.stableAssetUrl(key, config) },
  }
}
function manifests(store: ReturnType<typeof recordingStore>) {
  return store.writes.filter(write => write.key.endsWith("manifest.json")).map(write => JSON.parse(Buffer.from(write.body).toString()))
}

test("missing COS configuration fails before any storage or generation work", () => {
  assert.throws(() => assets.readCosConfig({}), /尚未配置对象存储/)
  const env = { COS_BUCKET:config.bucket, COS_REGION:config.region, COS_SECRET_ID:config.secretId, COS_SECRET_KEY:config.secretKey, COS_DOMAIN:config.domain, CDN_AUTH_KEY:config.cdnAuthKey, ASSET_ACCESS_SECRET:config.assetAccessSecret }
  assert.deepEqual(assets.readCosConfig(env), config)
  assert.throws(() => assets.readCosConfig({...env, COS_DOMAIN:"http://images.example"}), /域名配置无效/)
  assert.throws(() => assets.readCosConfig({...env, ASSET_ACCESS_SECRET:"short"}), /密钥配置无效/)
})

test("asset capability is stable, object-scoped, and rejects manifest/traversal paths", () => {
  const stable = assets.stableAssetUrl(key, config)
  const token = new URL(stable, "https://app.example").searchParams.get("access")
  assert.equal(assets.validateAssetAccess(key, token, config.assetAccessSecret), true)
  for (const invalid of [key.replace("final.png", "final.jpg"), key.replace("outputs/final.png", "manifest.json"), `${key}/../manifest.json`, key.replace("outputs", "%2e%2e"), key.replace("final.png", "final.svg")]) {
    assert.equal(assets.validateAssetAccess(invalid, token, config.assetAccessSecret), false)
  }
  assert.equal(assets.validateAssetAccess(key, "x", config.assetAccessSecret), false)
  assert.equal(assets.validateAssetAccess(key, token, "different-secret"), false)
  assert.equal(stable, assets.stableAssetUrl(key, config))
})

test("CDN signing uses configured domain and a decimal Type D timestamp", () => {
  const url = new URL(assets.signedCdnUrl(key, config, 1700000000123))
  assert.equal(url.origin, config.domain)
  assert.equal(url.pathname, `/${key}`)
  assert.equal(url.searchParams.get("t"), "1700000000")
  assert.equal(url.searchParams.get("sign"), createHash("md5").update(`${config.cdnAuthKey}/${key}1700000000`).digest("hex"))
})

test("asset route validates capability before COS access and serves private bytes on the app domain", async context => {
  context.mock.method(assets, "readCosConfig", () => config)
  let stores = 0
  let reads = 0
  context.mock.method(assets, "createCosStore", () => {
    stores++
    return { async getImage(objectKey: string) { reads++; assert.equal(objectKey, key); return image } }
  })
  const stable = assets.stableAssetUrl(key, config)
  const bad = await GET(new Request("https://app.example/api/assets/test?access=bad"), {params:Promise.resolve({key:key.split("/")})})
  assert.equal(bad.status, 403)
  const manifestKey = key.replace("outputs/final.png", "manifest.json")
  const manifest = await GET(new Request(`https://app.example${stable}`), {params:Promise.resolve({key:manifestKey.split("/")})})
  assert.equal(manifest.status, 403)
  assert.equal(stores, 0)
  assert.equal(reads, 0)

  const good = await GET(new Request(`https://app.example${stable}`), {params:Promise.resolve({key:key.split("/")})})
  assert.equal(good.status, 200)
  assert.equal(good.headers.has("location"), false)
  assert.equal(good.headers.get("content-type"), "image/png")
  assert.equal(good.headers.get("content-length"), String(png.length))
  assert.equal(good.headers.get("cache-control"), "private, no-store")
  assert.equal(good.headers.get("referrer-policy"), "no-referrer")
  assert.equal(good.headers.get("x-content-type-options"), "nosniff")
  assert.equal(good.headers.get("x-robots-tag"), "noindex, nofollow")
  assert.deepEqual(Buffer.from(await good.arrayBuffer()), png)
  assert.equal(stores, 1)
  assert.equal(reads, 1)
})

test("asset read errors do not leak storage errors or capability credentials", async context => {
  context.mock.method(assets, "readCosConfig", () => config)
  context.mock.method(assets, "createCosStore", () => ({ async getImage() { throw new Error("test-cos-secret should never leak") } }))
  const stable = assets.stableAssetUrl(key, config)
  const response = await GET(new Request(`https://app.example${stable}`), {params:Promise.resolve({key:key.split("/")})})
  assert.equal(response.status, 503)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  assert.equal((await response.text()).includes(config.secretKey), false)
})

test("COS adapter sends memory buffers with private ACL, never local file paths", async () => {
  let put: Record<string, any> | undefined
  let get: Record<string, any> | undefined
  const client = {
    putObject(params: Record<string, any>, callback: (error?:unknown)=>void) { put = params; callback() },
    getObject(params: Record<string, any>, callback: (error:unknown,data:unknown)=>void) { get = params; callback(null,{Body:png}) },
  }
  const store = assets.createCosStore(config, client)
  await store.put(key,png,"image/png")
  assert.equal(put!.ACL,"private")
  assert.equal(put!.Bucket,config.bucket)
  assert.deepEqual(put!.Body,png)
  assert.equal("FilePath" in put!,false)
  const got = await store.getImage(key)
  assert.deepEqual(Buffer.from(got.bytes),png)
  assert.equal("Output" in get!,false)
  assert.match(get!.Range,/^bytes=0-/)
})

test("COS request errors are sanitized", async () => {
  const client = { putObject(_params:unknown,callback:(error:unknown)=>void) {callback(new Error("test-cos-secret leaked by SDK"))}, getObject(){} }
  const store = assets.createCosStore(config,client)
  await assert.rejects(store.put(key,png,"image/png"),(error:Error)=> /存储服务写入失败/.test(error.message) && !error.message.includes(config.secretKey))
})

test("owned reference URLs require valid capability before reading private COS bytes", async () => {
  const store = recordingStore()
  let reads = 0
  store.getImage = async () => { reads++; return image }
  assert.equal(await assets.readOwnedAsset("https://external.example/file.png",store),null)
  await assert.rejects(assets.readOwnedAsset(`/api/assets/${key}?access=bad`,store),/凭据无效/)
  assert.equal(reads,0)
  const result = await assets.readOwnedAsset(assets.stableAssetUrl(key,config),store)
  assert.deepEqual(result,image)
  assert.equal(reads,1)
})

test("generation archives both references before billing and records result integrity without credentials", async () => {
  const store = recordingStore()
  let generated = 0
  const result = await generateAndStore(settings,input,store,undefined,async () => {
    generated++
    assert.equal(store.writes.filter(write=>write.key.includes("/inputs/")).length,2)
    assert.equal(manifests(store).at(-1).status,"generating")
    return image
  })
  assert.equal(generated,1)
  assert.equal(manifests(store)[0].status,"preparing")
  const final = manifests(store).at(-1)
  assert.equal(final.status,"complete")
  assert.equal(final.inputs.length,2)
  assert.equal(final.output.sha256,createHash("sha256").update(png).digest("hex"))
  assert.match(result.url,/^\/api\/assets\/image-playground\/runs\//)
  const serialized = JSON.stringify(manifests(store))
  assert.equal(final.prompt.text,input.prompt)
  for (const secret of [settings.apiKey,settings.baseUrl,config.secretKey,config.cdnAuthKey,config.assetAccessSecret]) assert.equal(serialized.includes(secret),false)
})

test("failed storage preflight or reference upload never invokes the model", async () => {
  for (const fail of [()=>true,(key:string)=>key.includes("/inputs/")]) {
    let generated = 0
    await assert.rejects(generateAndStore(settings,input,recordingStore(fail),undefined,async()=> {generated++;return image}))
    assert.equal(generated,0)
  }
})

test("failed final upload records failure without regenerating or returning a local fallback", async () => {
  const store = recordingStore(key=>key.includes("/outputs/"))
  let generated = 0
  await assert.rejects(generateAndStore(settings,input,store,undefined,async()=>{generated++;return image}),/storage failure/)
  assert.equal(generated,1)
  assert.equal(manifests(store).at(-1).status,"failed")
  assert.equal(manifests(store).at(-1).failedStage,"output")
  assert.equal(manifests(store).at(-1).output,null)
})

test("cancelled requests preserve already archived process records without calling the model", async () => {
  const controller = new AbortController()
  controller.abort()
  const store = recordingStore()
  let generated = 0
  await assert.rejects(generateAndStore(settings,input,store,controller.signal,async()=>{generated++;return image}),{name:"AbortError"})
  assert.equal(generated,0)
  assert.equal(manifests(store).at(-1).status,"cancelled")
})
