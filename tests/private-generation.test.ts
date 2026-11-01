import { strict as assert } from "node:assert"
import { test } from "node:test"
import sharp from "sharp"
import { AccountError } from "../lib/auth/errors"
import type { AccountIdentity } from "../lib/auth/guards"
import { composePrompt } from "../lib/document-context"
import { assertPrivateKey, privateRunPrefix, type PrivateCosStore } from "../lib/private-cos"
import { bytesHash, type ParsedPrivateGeneration } from "../lib/private-generation-input"
import { executePrivateGeneration, repairPrivateGeneration, readVerifiedPrivateAsset, type PrivateGenerationDependencies } from "../lib/private-generation"
import type { PrivateAssetRecord, PrivateManifest, PrivateRunRecord } from "../lib/private-workspace-records"
import type { PrivateRunStatus } from "../lib/private-workspace-types"
import type { ImageBytes } from "../lib/relay-image"
import { composeAnnotatedPrompt } from "../lib/image-annotations"
import { validateAnnotationExecution } from "../lib/annotation-execution"
import { serializeResolvedAnnotationCapabilityEvidence } from "../lib/annotation-capability"
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

function fixture(options: { parent?: boolean; reference?: boolean; document?: boolean; annotation?: boolean } = {}) {
  if (options.annotation) options.parent = true
  const now = Date.now()
  const prefix = privateRunPrefix(ownerId, creationId, runId)
  const input: ParsedPrivateGeneration = {
    command: { creationId, clientRequestId: runId, fingerprint: bytesHash("test-input-fingerprint"),
      parentVersionId: options.parent ? parentId : null, mappingId: "test-model", configRevision: 1,
      prompt: "仅把标题改为春日市集", aspectRatio: "square", quality: "auto",
      mode: options.parent || options.reference ? "image-editing" : "text-to-image" },
    references: options.reference ? [{ image: referenceImage }] : [], effectivePrompt: "仅把标题改为春日市集",
  }
  if (options.annotation) {
    input.command.annotationSnapshot = { schema: 1, coordinateSpace: "encoded-pixels-v1", baseVersionId: parentId,
      image: { assetId: baseAssetId, width: 1, height: 1, orientation: 1, pages: 1 },
      marks: [{ id: "63456789-2345-4234-9234-23456789abcd", number: 3, instruction: "改成绿色", geometry: { type: "rectangle", x: 0, y: 0, width: 1, height: 1 } }],
    }
    input.effectivePrompt = composeAnnotatedPrompt(input.command.prompt, input.command.annotationSnapshot)
  }
  if (options.document) {
    input.document = { name: "brief.txt", mediaType: "text/plain", bytes: Buffer.from("保留原布局"), text: "保留原布局", images: [], imageInspection: "none" }
    input.effectivePrompt = composePrompt(input.effectivePrompt, input.document!.name, input.document!.text)
  }
  if (options.annotation) input.command.fingerprint = bytesHash(JSON.stringify({ ...input.command, fingerprint: "", references: [], document: input.document ? { name: input.document.name, sha256: bytesHash(input.document.bytes), mediaType: input.document.mediaType } : null }))
  const record: PrivateRunRecord = {
    public: { id: runId, creationId, creationRevision: 2, version: 2, parentVersionId: input.command.parentVersionId,
      status: "preparing", imageUrl: null, annotationSnapshot: input.command.annotationSnapshot ?? null, prompt: input.command.prompt, mappingId: input.command.mappingId,
      modelLabel: "测试模型", aspectRatio: input.command.aspectRatio, quality: input.command.quality,
      mode: input.command.mode, createdAt: now, updatedAt: now },
    annotationExecution: null, ownerId, fingerprint: input.command.fingerprint, deadlineAt: now + 60_000,
    manifestKey: `${prefix}/manifest.json`, outputKey: `${prefix}/outputs/final`, outputAssetId,
    provider: { baseUrl: "https://provider.example/v1", apiMode: "images", modelId: "private-upstream-model", revision: 1,
      ...(options.annotation ? { annotationCapability: { expression: "overlay-v1" as const, maxInputImages: 2 as const, configurationRevision: 1, bindingSha256: "a".repeat(64), evidenceSha256: "b".repeat(64) } } : {}),
    },
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
      async freezePrivateAnnotationExecution(owner, id, execution) {
        assert.equal(owner, ownerId); assert.equal(id, runId)
        assert.equal(state.record.public.status, "preparing")
        assert.equal(state.record.annotationExecution, null)
        for (const asset of execution.inputs) assert.equal(bytesHash(objects.get(asset.key)!.bytes), asset.sha256)
        state.record.annotationExecution = validateAnnotationExecution(execution)
        events.push("freeze")
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

test("批注原图与辅助图成功归档并冻结后仅调用一次模型，历史公开快照无私有能力", async () => {
  const f = fixture({ annotation: true, document: true })
  f.state.generateHook = async (_settings, request) => {
    assert.equal(request.images.length, 2)
    assert.deepEqual(request.images[0].bytes, baseImage.bytes)
    assert.notDeepEqual(request.images[1].bytes, baseImage.bytes)
    assert.equal(request.images[1].mediaType, "image/png")
    assert.match(request.prompt, /改成绿色/)
    assert.ok(f.events.indexOf("freeze") < f.events.indexOf("generate"))
    const frozen = f.state.record.annotationExecution!
    assert.deepEqual(f.readManifest().annotationExecution, frozen)
    assert.equal(frozen.inputs[0].role, "original")
    assert.equal(frozen.inputs[1].role, "overlay")
    assert.equal(frozen.inputs[0].sha256, bytesHash(baseImage.bytes))
    return outputImage
  }
  const result = await executePrivateGeneration(identity, f.input, undefined, f.deps)
  assert.equal(result.status, "complete")
  assert.deepEqual(result.annotationSnapshot, f.input.command.annotationSnapshot)
  assert.doesNotMatch(JSON.stringify(result), /bindingSha256|evidenceSha256|image-playground/)
  assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).id, result.id)
  assert.equal(f.counts.generate, 1)
})

test("批注真实基准不匹配、额外参考或不明文档均在模型之前失败", async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.input.command.annotationSnapshot!.image.width = 2; f.record.public.annotationSnapshot = copy(f.input.command.annotationSnapshot!) },
    f => { f.input.command.annotationSnapshot!.image.orientation = 2; f.record.public.annotationSnapshot = copy(f.input.command.annotationSnapshot!) },
    f => { f.input.command.annotationSnapshot!.image.assetId = outputAssetId; f.record.public.annotationSnapshot = copy(f.input.command.annotationSnapshot!) },
    f => { f.input.references = [{ image: referenceImage }] },
    f => { f.input.document = { name: "unconfirmed.txt", mediaType: "text/plain", bytes: Buffer.from("note"), text: "note", images: [], imageInspection: "unknown" } },
    f => { f.record.provider.annotationCapability = null },
    f => { f.input.effectivePrompt += "tampered prompt" },
  ]
  for (const mutate of mutations) {
    const f = fixture({ annotation: true })
    mutate(f)
    assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).status, "failed")
    assert.equal(f.counts.generate, 0)
    assert.equal(f.state.record.annotationExecution, null)
  }
})

test("任一批注输入写入失败或冻结失败都不能调用模型", async () => {
  for (const failure of ["reference-1", "reference-2", "freeze"] as const) {
    const f = fixture({ annotation: true })
    if (failure === "freeze") f.deps.service.freezePrivateAnnotationExecution = async () => { throw new Error("synthetic freeze failure") }
    else f.state.beforePut = key => { if (key.endsWith(`/inputs/${failure}`)) throw new Error("synthetic input failure") }
    assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).status, "failed")
    assert.equal(f.counts.generate, 0)
  }
})

test("批注补保存仅核对冻结输入，配置变更、重复受理和修复均不重画或再次调用模型", async () => {
  const f = fixture({ annotation: true, document: true })
  f.state.completeFailures = 1
  assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).status, "save_pending")
  const inputWrites = f.writes.filter(item => item.key.includes("/inputs/")).length
  const execution = copy(f.state.record.annotationExecution)
  const repaired = await repairPrivateGeneration(identity, runId, f.deps)
  assert.equal(repaired.status, "complete")
  assert.deepEqual(repaired.annotationSnapshot, f.input.command.annotationSnapshot)
  assert.deepEqual(f.state.record.annotationExecution, execution)
  assert.equal(f.writes.filter(item => item.key.includes("/inputs/")).length, inputWrites)
  assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).id, repaired.id)
  assert.equal(f.counts.generate, 1)
})

function freezeSourceEvidence(f: ReturnType<typeof fixture>) {
  const capability = f.state.record.provider.annotationCapability!
  capability.sourceEvidence = { mappingId: f.record.public.mappingId, evidence: { id: "11111111-1111-4111-8111-111111111111", actorId: "synthetic-admin", recordedAt: "2026-10-30T00:00:00.000Z", reference: "https://synthetic.example/original-evidence", note: "受理时核对的完整资料证据", confirmed: true } }
  capability.evidenceSha256 = bytesHash(serializeResolvedAnnotationCapabilityEvidence(capability)!)
}

test("批注来源冻结至任务与清单，旧五字段继续兼容，公开结果不含证据", async () => {
  const f = fixture({ annotation: true })
  freezeSourceEvidence(f)
  f.state.completeFailures = 1
  const before = copy(f.state.record.provider.annotationCapability!)
  const pending = await executePrivateGeneration(identity, f.input, undefined, f.deps)
  assert.equal(pending.status, "save_pending")
  assert.deepEqual(f.state.record.annotationExecution!.capability, before)
  assert.deepEqual(f.readManifest().annotationExecution!.capability.sourceEvidence, before.sourceEvidence)
  assert.equal(bytesHash(serializeResolvedAnnotationCapabilityEvidence(before)!), before.evidenceSha256)
  const repaired = await repairPrivateGeneration(identity, runId, f.deps)
  assert.equal(repaired.status, "complete")
  assert.doesNotMatch(JSON.stringify(repaired), /sourceEvidence|受理时核对|actorId|original-evidence/)
  assert.equal(f.counts.generate, 1)
})

test("批注执行和修复拒绝来源证据摘要篡改，即使数据库及清单正文同时被替换", async () => {
  const beforeExecution = fixture({ annotation: true })
  freezeSourceEvidence(beforeExecution)
  beforeExecution.state.record.provider.annotationCapability!.sourceEvidence!.evidence.note = "被替换的来源"
  assert.equal((await executePrivateGeneration(identity, beforeExecution.input, undefined, beforeExecution.deps)).status, "failed")
  assert.equal(beforeExecution.counts.generate, 0)
  const f = fixture({ annotation: true })
  freezeSourceEvidence(f)
  f.state.completeFailures = 1
  assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).status, "save_pending")
  const manifest = f.readManifest()
  for (const capability of [f.state.record.provider.annotationCapability!, f.state.record.annotationExecution!.capability, manifest.provider.annotationCapability!, manifest.annotationExecution!.capability]) capability.sourceEvidence!.evidence.note = "被替换的来源"
  f.objects.set(f.record.manifestKey, { bytes: Buffer.from(JSON.stringify(manifest)), mediaType: "application/json" })
  await assert.rejects(repairPrivateGeneration(identity, runId, f.deps), expectCode("RUN_REPAIR_UNAVAILABLE"))
  assert.equal(f.counts.generate, 1)
  assert.equal(f.state.record.public.status, "save_pending")
})

test("修复对比完整数据库请求、批注快照和execution，拒绝角色、文档与字节篡改", async () => {
  const mutations: Array<(manifest: PrivateManifest, f: ReturnType<typeof fixture>) => void> = [
    manifest => { Object.assign(manifest, { unexpected: "untrusted content" }) },
    manifest => { manifest.input.prompt += "changed" },
    manifest => { manifest.input.configRevision++ },
    manifest => { manifest.input.annotationSnapshot!.marks[0].instruction = "tampered" },
    manifest => { manifest.annotationExecution!.snapshotSha256 = "0".repeat(64) },
    manifest => { manifest.annotationExecution!.capability.evidenceSha256 = "0".repeat(64) },
    manifest => { manifest.annotationExecution!.inputs.reverse() },
    manifest => { manifest.inputs.find(item => item.key.endsWith("/reference-2"))!.sha256 = "0".repeat(64) },
    manifest => { manifest.inputs = manifest.inputs.filter(item => item.kind !== "document") },
    (manifest, f) => {
      const document = manifest.inputs.find(item => item.kind === "document")!
      const changed = Buffer.from("伪造的文档")
      document.byteLength = changed.length; document.sha256 = bytesHash(changed)
      f.objects.set(document.key, { bytes: changed, mediaType: document.mediaType })
    },
    (manifest, f) => {
      const auxiliary = manifest.inputs.find(item => item.key.endsWith("/reference-2"))!
      f.objects.set(auxiliary.key, { bytes: baseImage.bytes, mediaType: "image/png" })
    },
    (_manifest, f) => { f.objects.set(f.base.key, { bytes: outputImage.bytes, mediaType: "image/png" }) },
  ]
  for (const change of mutations) {
    const f = fixture({ annotation: true, document: true })
    f.state.completeFailures = 1
    await executePrivateGeneration(identity, f.input, undefined, f.deps)
    const manifest = f.readManifest()
    change(manifest, f); f.replaceManifest(manifest)
    await assert.rejects(repairPrivateGeneration(identity, runId, f.deps), expectCode("RUN_REPAIR_UNAVAILABLE"))
    assert.equal(f.counts.generate, 1)
    assert.equal(f.counts.committed, 0)
  }
})

test("带CRLF和规范化文字的批注文档可补保存，恢复文本不会被文件后缀重新解释", async () => {
  for (const name of ["brief.txt", "restored.pdf"]) {
    const f = fixture({ annotation: true, document: true })
    const document = f.input.document!
    document.name = name; document.bytes = Buffer.from("  第一行\r\n第二行\r\n  "); document.text = "第一行\n第二行"
    f.input.effectivePrompt = composePrompt(composeAnnotatedPrompt(f.input.command.prompt, f.input.command.annotationSnapshot!), document.name, document.text)
    f.input.command.fingerprint = bytesHash(JSON.stringify({ ...f.input.command, fingerprint: "", references: [], document: { name: document.name, sha256: bytesHash(document.bytes), mediaType: document.mediaType } }))
    f.record.fingerprint = f.input.command.fingerprint
    f.state.completeFailures = 1
    assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).status, "save_pending")
    assert.equal((await repairPrivateGeneration(identity, runId, f.deps)).status, "complete")
    assert.equal(f.counts.generate, 1)
  }
})


test("旋转EXIF基准仍以原字节作为第一输入，辅助图按显示尺寸归档且可修复", async () => {
  const original = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#345678" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
  const f = fixture({ annotation: true })
  Object.assign(f.base, { mediaType: "image/jpeg", byteLength: original.length, sha256: bytesHash(original) })
  f.objects.set(f.base.key, { bytes: original, mediaType: "image/jpeg" })
  Object.assign(f.input.command.annotationSnapshot!.image, { width: 80, height: 60, orientation: 6 })
  f.record.public.annotationSnapshot = copy(f.input.command.annotationSnapshot!)
  f.input.effectivePrompt = composeAnnotatedPrompt(f.input.command.prompt, f.input.command.annotationSnapshot!)
  f.input.command.fingerprint = bytesHash(JSON.stringify({ ...f.input.command, fingerprint: "", references: [], document: null }))
  f.record.fingerprint = f.input.command.fingerprint
  f.state.generateHook = async (_settings, request) => {
    assert.deepEqual(Buffer.from(request.images[0].bytes), original)
    const overlay = await sharp(Buffer.from(request.images[1].bytes)).metadata()
    assert.equal(overlay.width, 60); assert.equal(overlay.height, 80)
    assert.equal(overlay.orientation ?? 1, 1)
    return outputImage
  }
  f.state.completeFailures = 1
  assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).status, "save_pending")
  assert.equal((await repairPrivateGeneration(identity, runId, f.deps)).status, "complete")
  assert.equal(f.state.record.annotationExecution!.original.orientation, 6)
  assert.equal(f.counts.generate, 1)
})


test("JPEG辅助图生成后可补保存，原图字节和旋转尺寸不变且mime必须匹配实际字节", async () => {
  const width = 2700, height = 2200
  const pixels = Buffer.alloc(width * height * 3)
  let seed = 0x357159ab
  for (let index = 0; index < pixels.length; index++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    pixels[index] = seed & 255
  }
  const original = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer()
  const f = fixture({ annotation: true })
  Object.assign(f.base, { mediaType: "image/jpeg", byteLength: original.length, sha256: bytesHash(original) })
  f.objects.set(f.base.key, { bytes: original, mediaType: "image/jpeg" })
  Object.assign(f.input.command.annotationSnapshot!.image, { width, height, orientation: 6 })
  f.record.public.annotationSnapshot = copy(f.input.command.annotationSnapshot!)
  f.input.effectivePrompt = composeAnnotatedPrompt(f.input.command.prompt, f.input.command.annotationSnapshot!)
  f.input.command.fingerprint = bytesHash(JSON.stringify({ ...f.input.command, fingerprint: "", references: [], document: null }))
  f.record.fingerprint = f.input.command.fingerprint
  f.state.generateHook = async (_settings, request) => {
    assert.equal(request.images.length, 2)
    assert.deepEqual(Buffer.from(request.images[0].bytes), original)
    assert.equal(request.images[1].mediaType, "image/jpeg")
    assert.ok(request.images[1].bytes.length <= 10 * 1024 * 1024)
    const metadata = await sharp(Buffer.from(request.images[1].bytes)).metadata()
    assert.equal(metadata.width, height); assert.equal(metadata.height, width)
    assert.equal(metadata.orientation ?? 1, 1)
    const execution = f.state.record.annotationExecution!
    assert.equal(execution.original.width, width); assert.equal(execution.original.height, height)
    assert.equal(execution.inputs[0].sha256, bytesHash(original))
    assert.equal(execution.inputs[1].sha256, bytesHash(request.images[1].bytes))
    return outputImage
  }
  f.state.completeFailures = 1
  assert.equal((await executePrivateGeneration(identity, f.input, undefined, f.deps)).status, "save_pending")
  const validManifest = f.readManifest()
  assert.equal(validManifest.inputs[1].mediaType, "image/jpeg")
  const falseMime = copy(validManifest)
  falseMime.inputs[1].mediaType = "image/png"
  f.replaceManifest(falseMime)
  await assert.rejects(repairPrivateGeneration(identity, runId, f.deps), expectCode("RUN_REPAIR_UNAVAILABLE"))
  f.replaceManifest(validManifest)
  const inputWrites = f.writes.filter(item => item.key.includes("/inputs/")).length
  assert.equal((await repairPrivateGeneration(identity, runId, f.deps)).status, "complete")
  assert.equal(f.writes.filter(item => item.key.includes("/inputs/")).length, inputWrites)
  assert.deepEqual(Buffer.from(f.objects.get(f.base.key)!.bytes), original)
  assert.equal(f.counts.generate, 1)
})
