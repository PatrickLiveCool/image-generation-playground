import { strict as assert } from "node:assert"
import { after, test } from "node:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import ts from "typescript"

// Replace the SDK before loading the adapter: this suite cannot open COS or write image files.
const dir = mkdtempSync(path.join(tmpdir(), "private-cos-contract-"))
for (const name of ["private-cos", "provider-network", "relay-image", "document-context"]) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8")
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  writeFileSync(path.join(dir, `${name}.js`), output.replace('require("cos-nodejs-sdk-v5")', 'require("./cos-sdk-stub")'))
}
writeFileSync(path.join(dir, "cos-sdk-stub.js"), `module.exports = class {
  static options = [];
  static fail = false;
  constructor(options) { if (this.constructor.fail) throw new Error("SDK private configuration"); this.constructor.options.push(options); }
  putObject() { throw new Error("Tests must inject a COS client"); }
  getObject() { throw new Error("Tests must inject a COS client"); }
}`)
const require = createRequire(import.meta.url)
const { privateRunPrefix, assertPrivateKey, createPrivateCosStore, MAX_PRIVATE_MANIFEST_BYTES } = require(path.join(dir, "private-cos.js")) as typeof import("../lib/private-cos")
const sdk = require(path.join(dir, "cos-sdk-stub.js")) as { options: Record<string, unknown>[]; fail: boolean }
after(() => rmSync(dir, { recursive: true, force: true }))

const env = { NODE_ENV: "test" as const, COS_BUCKET: "private-test-1234567890", COS_REGION: "ap-shanghai", COS_SECRET_ID: "test-id", COS_SECRET_KEY: "test-secret" }
const ownerId = "test-owner"
const creationId = "12345678-1234-4123-8123-123456789abc"
const runId = "23456789-2345-4234-9234-23456789abcd"
const prefix = privateRunPrefix(ownerId, creationId, runId)
const outputKey = `${prefix}/outputs/final`
const imageMax = 20 * 1024 * 1024
const documentMax = 10 * 1024 * 1024
type Client = NonNullable<Parameters<typeof createPrivateCosStore>[1]>

function memoryClient() {
  const puts: Record<string, unknown>[] = []
  const gets: Record<string, unknown>[] = []
  const objects = new Map<string, { bytes: Buffer; mediaType: string }>()
  const client: Client = {
    putObject(params, callback) {
      puts.push(params)
      objects.set(String(params.Key), { bytes: Buffer.from(params.Body as Uint8Array), mediaType: String(params.ContentType) })
      callback(null, { statusCode: 200 })
    },
    getObject(params, callback) {
      gets.push(params)
      const object = objects.get(String(params.Key))
      if (!object) { callback(new Error("NoSuchKey private-sdk-details")); return }
      callback(null, { statusCode: 206, Body: object.bytes, headers: {
        "content-length": String(object.bytes.byteLength), "content-type": object.mediaType,
        "content-range": `bytes 0-${object.bytes.byteLength - 1}/${object.bytes.byteLength}`,
      } })
    },
  }
  return { client, puts, gets, objects }
}

function safeError(status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.name, "ProviderError")
    assert.equal((error as Error & { status: number }).status, status)
    assert.doesNotMatch(error.message, /test-secret|private-sdk-details|SDK private configuration|NoSuchKey/)
    assert.equal("cause" in error, false)
    return true
  }
}

test("private prefixes hash the exact owner and canonicalize UUIDs without accepting malformed identities", () => {
  assert.equal(prefix, `image-playground/private/v1/${createHash("sha256").update(ownerId).digest("hex")}/${creationId}/${runId}`)
  assert.equal(privateRunPrefix(ownerId, creationId.toUpperCase(), runId.toUpperCase()), prefix)
  assert.notEqual(privateRunPrefix(" test-owner ", creationId, runId), prefix)
  assert.notEqual(privateRunPrefix("TEST-owner", creationId, runId), prefix)
  for (const owner of ["", " ", "owner\n", "owner\0", null, undefined, 1]) {
    assert.throws(() => privateRunPrefix(owner as string, creationId, runId), safeError(400))
  }
  for (const id of ["", "../run", `${runId}\n`, `${runId}/`, "g" + runId.slice(1), undefined]) {
    assert.throws(() => privateRunPrefix(ownerId, id as string, runId), safeError(400))
    assert.throws(() => privateRunPrefix(ownerId, creationId, id as string), safeError(400))
  }
})

test("only the fixed private namespace and seven permitted object paths are accepted", async () => {
  for (const leaf of ["manifest.json", "outputs/final", "inputs/reference-1", "inputs/reference-2", "inputs/document-image-1", "inputs/document-image-2", "inputs/document"]) {
    assert.doesNotThrow(() => assertPrivateKey(`${prefix}/${leaf}`))
  }
  const memory = memoryClient()
  const store = createPrivateCosStore(env, memory.client)
  const malformed = [
    `image-playground/runs/${runId}/outputs/final.png`,
    outputKey.replace("private/v1", "private/v2"), outputKey.replace(/[a-f0-9]{64}/, "owner"),
    outputKey.replace(/[a-f0-9]{64}/, "A".repeat(64)), outputKey.replace(creationId, "bad-id"),
    `${outputKey}.png`, `${prefix}/inputs/reference-3`, `${prefix}/inputs/document.pdf`,
    `${prefix}/inputs/../outputs/final`, `${prefix}/inputs/%2e%2e/outputs/final`,
    `${outputKey}?access=token`, `${outputKey}#fragment`, `${outputKey}\n`, `/${outputKey}`, `${outputKey}/`,
    outputKey.replace("/outputs/", "\\outputs\\"), "https://bucket.example/" + outputKey, null,
  ]
  for (const key of malformed) {
    assert.throws(() => assertPrivateKey(key as string), safeError(400))
    await assert.rejects(store.put(key as string, Buffer.from("x"), "image/png"), safeError(400))
    await assert.rejects(store.get(key as string, 1), safeError(400))
  }
  assert.equal(memory.puts.length + memory.gets.length, 0)
})

test("configuration needs only four COS fields and the SDK is HTTPS with redirects disabled", () => {
  const guardedEnv = new Proxy(env, { get(target, field: string) {
    if (["COS_DOMAIN", "CDN_AUTH_KEY", "ASSET_ACCESS_SECRET"].includes(field)) throw new Error("old access configuration must not be read")
    return target[field as keyof typeof env]
  } })
  createPrivateCosStore(guardedEnv)
  assert.deepEqual(sdk.options.at(-1), {
    SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY,
    Protocol: "https:", StrictSsl: true, FollowRedirect: false, AutoSwitchHost: false, Timeout: 60_000,
  })
  for (const field of ["COS_BUCKET", "COS_REGION", "COS_SECRET_ID", "COS_SECRET_KEY"]) {
    for (const value of [undefined, "", "  "]) assert.throws(() => createPrivateCosStore({ ...env, [field]: value }), safeError(503))
  }
  for (const [field, value] of [["COS_BUCKET", "bucket"], ["COS_BUCKET", "../bucket-123"], ["COS_BUCKET", `${env.COS_BUCKET}\n`], ["COS_REGION", "https://region"], ["COS_REGION", `${env.COS_REGION}\n`]]) {
    assert.throws(() => createPrivateCosStore({ ...env, [field]: value }), safeError(503))
  }
  sdk.fail = true
  try { assert.throws(() => createPrivateCosStore(env), safeError(503)) } finally { sdk.fail = false }
})

test("uploads remain private and no-store, use memory copies, and support same-key retries", async () => {
  const memory = memoryClient()
  const store = createPrivateCosStore(env, memory.client)
  const bytes = new Uint8Array([1, 2, 3])
  for (const key of [outputKey, `${prefix}/manifest.json`, `${prefix}/inputs/document`]) {
    await store.put(key, bytes, "application/octet-stream")
    await store.put(key, bytes, "application/octet-stream")
  }
  assert.equal(memory.puts.length, 6)
  for (const params of memory.puts) {
    assert.equal(params.Bucket, env.COS_BUCKET)
    assert.equal(params.Region, env.COS_REGION)
    assert.equal(params.ACL, "private")
    assert.equal(params.CacheControl, "private, no-store")
    assert.equal(params.ContentLength, bytes.byteLength)
    assert.ok(Buffer.isBuffer(params.Body))
    assert.notEqual(params.Body, bytes)
    assert.deepEqual(params.Body, Buffer.from(bytes))
    assert.equal("FilePath" in params, false)
  }
  bytes[0] = 99
  assert.equal((memory.puts[0].Body as Buffer)[0], 1)
})

test("key-specific upload caps reject empty, invalid, and oversized bytes before any SDK call", async () => {
  const memory = memoryClient()
  const store = createPrivateCosStore(env, memory.client)
  assert.equal(MAX_PRIVATE_MANIFEST_BYTES, 256 * 1024)
  for (const [key, limit] of [[outputKey, imageMax], [`${prefix}/manifest.json`, MAX_PRIVATE_MANIFEST_BYTES], [`${prefix}/inputs/document`, documentMax]] as const) {
    for (const bytes of [new Uint8Array(), Buffer.alloc(limit + 1), "text", null]) {
      await assert.rejects(store.put(key, bytes as Uint8Array, "application/octet-stream"), safeError(400))
    }
    await store.put(key, Buffer.alloc(limit), "application/octet-stream")
  }
  assert.equal(memory.puts.length, 3)
  for (const type of ["", "image", "image/png\r\nInjected: yes", "image/" + "a".repeat(300), null]) {
    await assert.rejects(store.put(outputKey, Buffer.from("x"), type as string), safeError(400))
  }
  assert.equal(memory.puts.length, 3)
})

test("reads request one extra byte, check SDK response headers, and return metadata without trusting it as image evidence", async () => {
  const memory = memoryClient()
  const store = createPrivateCosStore(env, memory.client)
  const bytes = Buffer.from("these bytes are not an image")
  await store.put(outputKey, bytes, "image/png")
  const result = await store.get(outputKey, bytes.byteLength)
  assert.deepEqual(result, { bytes, mediaType: "image/png" })
  assert.notEqual(result.bytes, memory.objects.get(outputKey)!.bytes)
  assert.deepEqual(memory.gets[0], { Bucket: env.COS_BUCKET, Region: env.COS_REGION, Key: outputKey, Range: `bytes=0-${bytes.byteLength}` })
})

test("read limits must be positive safe integers within the object's own hard cap", async () => {
  const memory = memoryClient()
  const store = createPrivateCosStore(env, memory.client)
  for (const [key, limit] of [[outputKey, imageMax], [`${prefix}/manifest.json`, MAX_PRIVATE_MANIFEST_BYTES], [`${prefix}/inputs/document`, documentMax]] as const) {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, limit + 1, "1", null]) {
      await assert.rejects(store.get(key, value as number), safeError(400))
    }
  }
  assert.equal(memory.gets.length, 0)
})

test("reads reject missing, empty, oversized, truncated, or size-mismatched bodies and invalid response metadata", async () => {
  const bytes = Buffer.from([1, 2, 3])
  const base = { Body: bytes, ContentLength: 3, ContentType: "image/png" }
  const invalidResponses = [
    undefined, {}, { ...base, Body: "123" }, { ...base, Body: new ArrayBuffer(3) },
    { ...base, Body: Buffer.alloc(0), ContentLength: 0 }, { ...base, Body: Buffer.alloc(4), ContentLength: 4 },
    ...[undefined, null, "3\n", "03", "3.0", "3e0", 2, 4, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, [3]].map(ContentLength => ({ ...base, ContentLength })),
    { ...base, headers: { "content-length": "4" } }, { ...base, statusCode: 301 },
    { ...base, ContentRange: "bytes 0-2/100" }, { ...base, headers: { "content-range": "bytes 1-3/4" } },
    { ...base, ContentType: "image/png\r\nInjected: yes" },
  ]
  for (const response of invalidResponses) {
    const store = createPrivateCosStore(env, { putObject() {}, getObject(_params, callback) { callback(null, response) } })
    await assert.rejects(store.get(outputKey, 3), safeError(502))
  }
  for (const response of [base, { Body: bytes, ContentLength: "3" }, { Body: bytes, headers: { "content-length": "3" } }]) {
    const store = createPrivateCosStore(env, { putObject() {}, getObject(_params, callback) { callback(null, response) } })
    const result = await store.get(outputKey, 3)
    assert.deepEqual(result.bytes, bytes)
    assert.equal(result.mediaType, "ContentType" in response ? response.ContentType : "application/octet-stream")
  }
})

test("SDK errors, throws, and redirects are sanitized without adapter-level retries", async () => {
  for (const failure of ["callback", "throw", "redirect"] as const) {
    let writes = 0
    let reads = 0
    const error = new Error("test-secret private-sdk-details")
    const client: Client = {
      putObject(_params, callback) {
        writes++
        if (failure === "throw") throw error
        callback(failure === "callback" ? error : null, { statusCode: 302 })
      },
      getObject(_params, callback) {
        reads++
        if (failure === "throw") throw error
        callback(failure === "callback" ? error : null, { Body: Buffer.from("x"), ContentLength: 1, statusCode: 302 })
      },
    }
    const store = createPrivateCosStore(env, client)
    await assert.rejects(store.put(outputKey, Buffer.from("x"), "image/png"), safeError(503))
    await assert.rejects(store.get(outputKey, 1), safeError(502))
    assert.equal(writes, 1)
    assert.equal(reads, 1)
  }
})
