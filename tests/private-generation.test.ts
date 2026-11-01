import { strict as assert } from "node:assert"
import { test } from "node:test"
import { AccountError } from "../lib/auth/errors"
import type { AccountIdentity } from "../lib/auth/guards"
import { composePrompt } from "../lib/document-context"
import { assertPrivateKey, privateRunPrefix, type PrivateCosStore } from "../lib/private-cos"
import { bytesHash, type ParsedPrivateGeneration } from "../lib/private-generation-input"
import { executePrivateGeneration, repairPrivateGeneration, readVerifiedPrivateAsset, type PrivateGenerationDependencies } from "../lib/private-generation"
import type { PrivateAssetRecord, PrivateManifest, PrivateRunRecord } from "../lib/private-workspace-records"
import type { PrivateRunStatus } from "../lib/private-workspace-types"
import type { ImageBytes } from "../lib/relay-image"
import { ProviderError } from "../lib/provider-network"

const ownerId = "32345678-1234-4123-8123-123456789abc"
const creationId = "12345678-1234-4123-8123-123456789abc"
const runId = "23456789-2345-4234-9234-23456789abcd"
const parentId = "33456789-2345-4234-9234-23456789abcd"
const outputAssetId = "43456789-2345-4234-9234-23456789abcd"
const baseAssetId = "53456789-2345-4234-9234-23456789abcd"
const identity: AccountIdentity = {
  user: { id: ownerId, username: "test-account", name: "Test", role: "user", mustChangePassword: false },
  sessionId: "test-session", sessionToken: "test-session-secret",
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64")
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")
const baseImage: ImageBytes = { bytes: png, mediaType: "image/png" }
const referenceImage: ImageBytes = { bytes: gif, mediaType: "image/gif" }
const outputImage: ImageBytes = { bytes: Buffer.concat([png, Buffer.from("synthetic-output")]), mediaType: "image/png" }
const copy = <T>(value: T): T => structuredClone(value)

function expectCode(code: string) {
  return (error: unknown) => error instanceof AccountError && error.code === code
}

function fixture(options: { parent?: boolean; reference?: boolean; document?: boolean } = {}) {
  const now = Date.now()
  const prefix = privateRunPrefix(ownerId, creationId, runId)
  const input: ParsedPrivateGeneration = {
    command: { creationId, clientRequestId: runId, fingerprint: bytesHash("test-input-fingerprint"),
      parentVersionId: options.parent ? parentId : null, mappingId: "test-model", configRevision: 1,
      prompt: "仅把标题改为春日市集", aspectRatio: "square", quality: "auto",
      mode: options.parent || options.reference ? "image-editing" : "text-to-image" },
    references: options.reference ? [{ image: referenceImage }] : [], effectivePrompt: "仅把标题改为春日市集",
  }
  if (options.document) {
    input.document = { name: "brief.txt", mediaType: "text/plain", bytes: Buffer.from("保留原布局"), text: "保留原布局", images: [] }
    input.effectivePrompt = composePrompt(input.command.prompt, input.document.name, input.document.text)
  }
  const record: PrivateRunRecord = {
    public: { id: runId, creationId, creationRevision: 2, version: 2, parentVersionId: input.command.parentVersionId,
      status: "preparing", imageUrl: null, prompt: input.command.prompt, mappingId: input.command.mappingId,
      modelLabel: "测试模型", aspectRatio: input.command.aspectRatio, quality: input.command.quality,
      mode: input.command.mode, createdAt: now, updatedAt: now },
    ownerId, fingerprint: input.command.fingerprint, deadlineAt: now + 60_000,
    manifestKey: `${prefix}/manifest.json`, outputKey: `${prefix}/outputs/final`, outputAssetId,
    provider: { baseUrl: "https://provider.example/v1", apiMode: "images", modelId: "private-upstream-model", revision: 1 },
  }
  const base: PrivateAssetRecord = {
    id: baseAssetId, ownerId, creationId, runId: parentId,
    key: `${privateRunPrefix(ownerId, creationId, parentId)}/outputs/final`, kind: "image", mediaType: baseImage.mediaType,
    byteLength: baseImage.bytes.length, sha256: bytesHash(baseImage.bytes),
  }
  const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>()
  if (options.parent) objects.set(base.key, { bytes: Buffer.from(baseImage.bytes), mediaType: baseImage.mediaType })
  const events: string[] = []
  const reads: string[] = []
  const writes: Array<{ key: string; bytes: Uint8Array; mediaType: string }> = []
  const counts = { generate: 0, accept: 0, complete: 0, committed: 0, reauthorize: 0, externalRead: 0 }
  const state: {
    accepted: boolean; record: PrivateRunRecord; base: PrivateAssetRecord | null; completeFailures: number
    beforePut?: (key: string, bytes: Uint8Array) => void
    afterPut?: (key: string, bytes: Uint8Array) => void
    generateHook?: PrivateGenerationDependencies["generate"]
    reauthorizeHook?: PrivateGenerationDependencies["reauthorize"]
  } = { accepted: false, record, base: options.parent ? base : null, completeFailures: 0 }
  const checkOwner = (current: AccountIdentity) => {
    if (current.user.id !== ownerId) throw new AccountError("NOT_FOUND", 404, "内容不存在。")
  }
  const store: PrivateCosStore = {
    async put(key, bytes, mediaType) {
      assertPrivateKey(key)
      state.beforePut?.(key, bytes)
      objects.set(key, { bytes: Buffer.from(bytes), mediaType })
      writes.push({ key, bytes: Buffer.from(bytes), mediaType })
      events.push(`put:${key}`)
      state.afterPut?.(key, bytes)
    },
    async get(key, maximum) {
      assertPrivateKey(key)
      reads.push(key)
      const object = objects.get(key)
      if (!object || !object.bytes.length || object.bytes.length > maximum) throw new Error("in-memory object unavailable")
      return { bytes: Buffer.from(object.bytes), mediaType: object.mediaType }
    },
  }
  const deps: PrivateGenerationDependencies = {
    store,
    service: {
      async acceptPrivateRun(current, command) {
        checkOwner(current)
        counts.accept++
        assert.equal(command.clientRequestId, runId)
        assert.equal(command.fingerprint, record.fingerprint)
        const acquired = !state.accepted
        state.accepted = true
        return { acquired, record: copy(state.record), ...(acquired ? { settings: { baseUrl: record.provider.baseUrl, apiKey: "test-model-secret", apiMode: "images" as const } } : {}) }
      },
      async readPrivateRun(current, id) {
        checkOwner(current)
        if (id !== runId) throw new AccountError("NOT_FOUND", 404, "内容不存在。")
        return copy(state.record)
      },
      async readPrivateAsset(current, id, kind) {
        checkOwner(current)
        if (id !== baseAssetId || !state.base || (kind && kind !== state.base.kind)) throw new AccountError("NOT_FOUND", 404, "内容不存在。")
        return copy(state.base)
      },
      async readPrivateBase(current, requestedCreation, requestedParent) {
        checkOwner(current)
        assert.equal(requestedCreation, creationId)
        assert.equal(requestedParent, parentId)
        return copy(state.base)
      },
      async setPrivateRunStatus(owner, id, status, failureCode) {
        assert.equal(owner, ownerId)
        assert.equal(id, runId)
        events.push(`status:${status}`)
        if (state.record.public.status === "complete") return
        state.record.public = { ...state.record.public, status, ...(failureCode ? { failureCode } : {}), updatedAt: Date.now() }
      },
      async completePrivateRun(owner, id, assets) {
        assert.equal(owner, ownerId)
        assert.equal(id, runId)
        counts.complete++
        events.push("complete")
        if (state.completeFailures > 0) { state.completeFailures--; throw new Error("simulated database failure") }
        if (state.record.public.status === "complete") return copy(state.record.public)
        assert.equal(assets.filter(asset => asset.key === record.outputKey).length, 1)
        for (const asset of assets) {
          assert.equal(asset.ownerId, ownerId)
          assert.equal(asset.creationId, creationId)
          assert.equal(asset.runId, runId)
          assertPrivateKey(asset.key)
        }
        counts.committed++
        state.record.public = { ...state.record.public, status: "complete", imageUrl: `/api/images/${outputAssetId}`, updatedAt: Date.now() }
        delete state.record.public.failureCode
        return copy(state.record.public)
      },
    },
    async generate(settings, request, signal) {
      counts.generate++
      events.push("generate")
      assert.equal(settings.apiKey, "test-model-secret")
      const manifest = readManifest()
      assert.equal(manifest.status, "generating")
      for (const asset of manifest.inputs) assert.equal(bytesHash(objects.get(asset.key)!.bytes), asset.sha256)
      return state.generateHook ? state.generateHook(settings, request, signal) : outputImage
    },
    async readSource() { counts.externalRead++; throw new Error("Unexpected external reference read") },
    async reauthorize(current) {
      counts.reauthorize++
      events.push("reauthorize")
      checkOwner(current)
      return state.reauthorizeHook?.(current)
    },
  }
  function readManifest(): PrivateManifest {
    return JSON.parse(Buffer.from(objects.get(record.manifestKey)!.bytes).toString("utf8")) as PrivateManifest
  }
  function replaceManifest(manifest: unknown) {
    objects.set(record.manifestKey, { bytes: Buffer.from(JSON.stringify(manifest)), mediaType: "application/json" })
  }
  return { input, record, base, objects, reads, writes, events, counts, state, deps, readManifest, replaceManifest }
}

test("editing submits the original parent first, preserves raw prompt, and archives all inputs before one model call", async () => {
  const f = fixture({ parent: true, reference: true, document: true })
  f.state.generateHook = async (_settings, request) => {
    assert.equal(request.model, f.record.provider.modelId)
    assert.equal(request.images.length, 2)
    assert.deepEqual(request.images[0].bytes, baseImage.bytes)
    assert.deepEqual(request.images[1].bytes, referenceImage.bytes)
    assert.equal(request.prompt.match(/【文档上下文：brief.txt】/g)?.length, 1)
    assert.match(request.prompt, /^以第一张图片为编辑基准/)
    assert.ok(f.events.indexOf("reauthorize") < f.events.indexOf("generate"))
    return outputImage
  }
  const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
  assert.equal(result.status, "complete")
  assert.equal(result.prompt, f.input.command.prompt)
  assert.equal(result.imageUrl, `/api/images/${outputAssetId}`)
  assert.equal(f.counts.generate, 1)
  assert.equal(f.counts.externalRead, 0)
  const manifest = f.readManifest()
  assert.equal(manifest.input.prompt, f.input.command.prompt)
  const baseInput = manifest.inputs.find(asset => asset.id === manifest.baseInputId)!
  assert.equal(baseInput.key, `${privateRunPrefix(ownerId, creationId, runId)}/inputs/reference-1`)
  assert.equal(baseInput.sha256, f.base.sha256)
  assert.equal(manifest.inputs.length, 3)
  const serialized = JSON.stringify(manifest)
  assert.doesNotMatch(serialized, /test-model-secret|test-session-secret/)
  assert.ok(f.events.lastIndexOf(`put:${f.record.manifestKey}`) < f.events.indexOf("complete"))
})

test("a missing or corrupted parent fails without falling back to text-to-image", async () => {
  for (const problem of ["missing", "hash", "format"] as const) {
    const f = fixture({ parent: true })
    if (problem === "missing") f.state.base = null
    else if (problem === "hash") f.state.base!.sha256 = "0".repeat(64)
    else f.state.base!.mediaType = "image/jpeg"
    const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
    assert.equal(result.status, "failed")
    assert.equal(result.imageUrl, null)
    assert.equal(f.counts.generate, 0)
    assert.equal(f.objects.has(f.record.outputKey), false)
  }
})

test("initial manifest, reference, or original-document write failure prevents all model calls", async () => {
  for (const failure of ["manifest", "reference", "document"] as const) {
    const f = fixture({ reference: true, document: true })
    f.state.beforePut = key => {
      if (failure === "manifest" ? key === f.record.manifestKey : key.endsWith(failure === "reference" ? "/inputs/reference-1" : "/inputs/document")) {
        throw new Error("simulated pre-model storage failure")
      }
    }
    const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
    assert.equal(result.status, "failed")
    assert.equal(result.failureCode, "INPUT_SAVE_FAILED")
    assert.equal(f.counts.generate, 0)
    assert.equal(f.counts.complete, 0)
  }
})

test("existing request keys return their current state without model, COS, or reauthorization work", async () => {
  for (const status of ["preparing", "generating", "unknown", "save_pending", "complete"] satisfies PrivateRunStatus[]) {
    const f = fixture()
    f.state.accepted = true
    f.state.record.public.status = status
    if (status === "complete") f.state.record.public.imageUrl = `/api/images/${outputAssetId}`
    const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
    assert.deepEqual(result, f.state.record.public)
    assert.equal(f.counts.generate + f.counts.reauthorize, 0)
    assert.equal(f.reads.length + f.writes.length, 0)
  }
})

test("a model timeout leaves an unknown result; querying or repairing cannot silently regenerate", async () => {
  const f = fixture({ reference: true })
  f.state.generateHook = async () => { throw new DOMException("simulated model timeout", "TimeoutError") }
  const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
  assert.equal(result.status, "unknown")
  assert.equal(result.failureCode, "GENERATION_UNKNOWN")
  assert.equal(f.readManifest().status, "unknown")
  assert.equal(f.objects.has(f.record.outputKey), false)
  assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).status, "unknown")
  await assert.rejects(repairPrivateGeneration(identity, runId, f.deps), expectCode("RUN_OUTPUT_UNCONFIRMED"))
  assert.equal(f.counts.generate, 1)
  assert.equal(f.counts.complete, 0)
})

test("model completion followed by unavailable final manifests recovers from the fixed output without another model call", async () => {
  const f = fixture({ reference: true })
  f.state.beforePut = key => {
    if (key === f.record.manifestKey && f.counts.generate > 0) throw new Error("simulated completion-manifest outage")
  }
  const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
  assert.equal(result.status, "save_pending")
  assert.equal(result.failureCode, "MANIFEST_SAVE_FAILED")
  assert.equal(f.readManifest().status, "generating")
  assert.equal(f.readManifest().output, null)
  assert.equal(f.objects.has(f.record.outputKey), true)
  f.state.beforePut = undefined
  const repaired = await repairPrivateGeneration(identity, runId, f.deps)
  assert.equal(repaired.id, result.id)
  assert.equal(repaired.version, result.version)
  assert.equal(repaired.status, "complete")
  assert.equal(f.readManifest().output!.sha256, bytesHash(outputImage.bytes))
  assert.equal(f.counts.generate, 1)
  assert.equal(f.counts.committed, 1)
})

test("metadata failure preserves the completed manifest and repeated repair commits the same version only once", async () => {
  const f = fixture({ parent: true })
  f.state.completeFailures = 1
  const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
  assert.equal(result.status, "save_pending")
  assert.equal(result.failureCode, "METADATA_SAVE_FAILED")
  assert.equal(f.readManifest().status, "complete")
  const repaired = await repairPrivateGeneration(identity, runId, f.deps)
  const writes = f.writes.length
  const reads = f.reads.length
  const completions = f.counts.complete
  assert.deepEqual(await repairPrivateGeneration(identity, runId, f.deps), repaired)
  assert.deepEqual(await executePrivateGeneration(identity, f.input, undefined, f.deps), repaired)
  assert.equal(f.writes.length, writes)
  assert.equal(f.reads.length, reads)
  assert.equal(f.counts.complete, completions)
  assert.equal(f.counts.generate, 1)
  assert.equal(f.counts.committed, 1)
})

test("an output PUT that actually saved bytes but lost its response can be repaired without rerunning the model", async () => {
  const f = fixture({ reference: true })
  let ambiguous = true
  f.state.afterPut = key => {
    if (key === f.record.outputKey && ambiguous) { ambiguous = false; throw new Error("simulated lost PUT response") }
  }
  const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
  assert.equal(result.status, "save_pending")
  assert.equal(result.failureCode, "OUTPUT_SAVE_FAILED")
  assert.equal(f.objects.has(f.record.outputKey), true)
  assert.equal((await repairPrivateGeneration(identity, runId, f.deps)).status, "complete")
  assert.equal(f.writes.filter(write => write.key === f.record.outputKey).length, 1)
  assert.equal(f.counts.generate, 1)
  assert.equal(f.counts.committed, 1)
})

test("repair remains pending on another metadata failure and a later retry never calls the model", async () => {
  const f = fixture()
  f.state.completeFailures = 2
  await executePrivateGeneration(identity, f.input, undefined, f.deps)
  await assert.rejects(repairPrivateGeneration(identity, runId, f.deps), expectCode("RUN_REPAIR_SAVE_PENDING"))
  assert.equal(f.counts.committed, 0)
  assert.equal((await repairPrivateGeneration(identity, runId, f.deps)).status, "complete")
  assert.equal(f.counts.generate, 1)
  assert.equal(f.counts.committed, 1)
})

test("authorization revoked before calling the model prevents billing despite archived inputs", async () => {
  const f = fixture({ reference: true })
  f.state.reauthorizeHook = async () => { throw new AccountError("UNAUTHENTICATED", 401, "账号已停用") }
  const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
  assert.equal(result.status, "failed")
  assert.equal(f.counts.reauthorize, 1)
  assert.equal(f.counts.generate, 0)
  assert.equal(f.readManifest().inputs.length, 1)
  assert.equal(f.objects.has(f.record.outputKey), false)
})

test("repair rejects foreign owners before object access and refuses an actively running task", async () => {
  const f = fixture()
  const foreign = { ...identity, user: { ...identity.user, id: "another-owner" } }
  await assert.rejects(repairPrivateGeneration(foreign, runId, f.deps), expectCode("NOT_FOUND"))
  assert.equal(f.reads.length, 0)
  await assert.rejects(repairPrivateGeneration(identity, runId, f.deps), expectCode("RUN_STILL_RUNNING"))
  assert.equal(f.reads.length, 0)
  assert.equal(f.counts.generate, 0)
})

test("repair rejects malformed manifests, wrong ownership, input hashes, and output hashes", async () => {
  const mutations: Array<{ change: (manifest: PrivateManifest) => void; code: string }> = [
    { change: manifest => { manifest.schema = 2 as 1 }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.ownerId = "foreign-owner" }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.creationId = parentId }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.runId = parentId }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.fingerprint = "0".repeat(64) }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.input.fingerprint = "0".repeat(64) }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.inputs[0].ownerId = "foreign-owner" }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.inputs[0].key = `${privateRunPrefix("foreign-owner", creationId, runId)}/inputs/reference-1` }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.inputs[0].sha256 = "0".repeat(64) }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.inputs.push(copy(manifest.inputs[0])) }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.baseInputId = outputAssetId }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.output!.ownerId = "foreign-owner" }, code: "RUN_REPAIR_UNAVAILABLE" },
    { change: manifest => { manifest.output!.sha256 = "0".repeat(64) }, code: "RUN_OUTPUT_UNCONFIRMED" },
  ]
  for (const { change, code } of mutations) {
    const f = fixture({ parent: true })
    f.state.completeFailures = 1
    await executePrivateGeneration(identity, f.input, undefined, f.deps)
    const manifest = f.readManifest()
    change(manifest)
    f.replaceManifest(manifest)
    await assert.rejects(repairPrivateGeneration(identity, runId, f.deps), expectCode(code))
    assert.equal(f.counts.generate, 1)
    assert.equal(f.counts.committed, 0)
  }
  for (const invalid of ["{invalid json", "null", "[]"]) {
    const f = fixture()
    f.state.record.public.status = "unknown"
    f.objects.set(f.record.manifestKey, { bytes: Buffer.from(invalid), mediaType: "application/json" })
    await assert.rejects(repairPrivateGeneration(identity, runId, f.deps), expectCode("RUN_REPAIR_UNAVAILABLE"))
    assert.equal(f.counts.generate, 0)
  }
})

test("verified asset reads enforce recorded length, digest, and sniffed media type", async () => {
  const f = fixture({ parent: true })
  for (const patch of [{ byteLength: 0 }, { byteLength: 21 * 1024 * 1024 }, { byteLength: f.base.byteLength + 1 }, { sha256: "0".repeat(64) }, { mediaType: "image/jpeg" }]) {
    await assert.rejects(readVerifiedPrivateAsset({ ...f.base, ...patch }, f.deps.store), expectCode("PRIVATE_ASSET_INVALID"))
  }
  // COS metadata is not trusted: the recorded type and actual bytes remain the source of truth.
  f.objects.set(f.base.key, { bytes: Buffer.from(baseImage.bytes), mediaType: "image/jpeg" })
  assert.deepEqual(await readVerifiedPrivateAsset(f.base, f.deps.store), { bytes: baseImage.bytes, mediaType: "image/png" })
})

test("account revocation during input persistence prevents the later model request", async () => {
  const f = fixture()
  let revoked = false
  f.state.afterPut = (key, bytes) => {
    if (key === f.record.manifestKey && JSON.parse(bytes.toString()).status === "generating") revoked = true
  }
  f.state.reauthorizeHook = async () => { if (revoked) throw new AccountError("FORBIDDEN", 403, "账号已停用") }
  const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
  assert.equal(result.status, "failed")
  assert.equal(result.failureCode, "ACCOUNT_UNAVAILABLE")
  assert.equal(f.counts.reauthorize, 2)
  assert.equal(f.counts.generate, 0)
})

test("invalid reference pixels never reach a model and invalid model pixels never complete", async () => {
  const badReference = fixture()
  badReference.input.references = [{ image: { bytes: baseImage.bytes.subarray(0, 8), mediaType: "image/png" } }]
  const rejected = await executePrivateGeneration(identity, badReference.input, undefined, badReference.deps)
  assert.equal(rejected.failureCode, "REFERENCE_INVALID")
  assert.equal(rejected.status, "failed")
  assert.equal(badReference.counts.generate, 0)

  const badOutput = fixture()
  badOutput.state.generateHook = async () => ({ bytes: baseImage.bytes.subarray(0, 8), mediaType: "image/png" })
  const failed = await executePrivateGeneration(identity, badOutput.input, undefined, badOutput.deps)
  assert.equal(failed.status, "failed")
  assert.equal(failed.failureCode, "MODEL_OUTPUT_INVALID")
  assert.equal(badOutput.counts.committed, 0)
  assert.equal(badOutput.objects.has(badOutput.record.outputKey), false)
})

test("fixed provider failure codes distinguish explicit rejection from uncertain upstream errors", async () => {
  for (const [code, expected] of [["PROVIDER_AUTH_REJECTED", "failed"], ["PROVIDER_REQUEST_REJECTED", "failed"], ["PROVIDER_RATE_LIMITED", "failed"], ["PROVIDER_UPSTREAM_FAILED", "unknown"]] as const) {
    const f = fixture()
    f.state.generateHook = () => { throw new ProviderError("never expose raw upstream token or response", 502, code) }
    const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
    assert.equal(result.status, expected)
    assert.equal(result.failureCode, code)
    assert.doesNotMatch(JSON.stringify(result), /never expose|raw upstream/)
    assert.equal(f.counts.generate, 1)
    assert.equal(f.counts.committed, 0)
  }
})
