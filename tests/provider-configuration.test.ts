import assert from "node:assert/strict"
import { createCipheriv } from "node:crypto"
import { test } from "node:test"
import { AccountError } from "../lib/auth/errors"
import { readJson } from "../lib/auth/validation"
import { MAX_PROVIDER_JSON_BYTES, validateProviderConfiguration } from "../lib/provider-configuration"
import { decryptProviderSecret, encryptProviderSecret, providerConfigurationKey } from "../lib/provider-secret"

const key = Buffer.alloc(32, 49).toString("base64")
const environment: NodeJS.ProcessEnv = { PROVIDER_CONFIG_KEY: key, NODE_ENV: "test" }
const expectCode = (code: string) => (error: unknown) => error instanceof AccountError && error.code === code
const input = () => ({ revision: 0, settings: { baseUrl: "https://provider.example/v1", apiKey: "synthetic-secret-only", apiMode: "images" }, models: [{ id: "model-a" }], mappings: [{ id: "stable-a", name: "均衡", modelId: "model-a" }], modelsSynced: true })

test("AES-GCM 使用独立严格 base64 密钥、随机 nonce，可由同一密钥恢复", () => {
  const one = encryptProviderSecret("synthetic-token", environment)
  const two = encryptProviderSecret("synthetic-token", environment)
  assert.notEqual(one, two)
  assert.equal(one.includes("synthetic-token"), false)
  assert.equal(decryptProviderSecret(one, environment), "synthetic-token")
  assert.equal(decryptProviderSecret(two, { ...environment, PROVIDER_CONFIG_KEY: key }), "synthetic-token")
  for (const invalid of [undefined, "", " "+key, key+"\n", key.replace(/=$/, ""), Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), "_".repeat(43)+"=", "A".repeat(42)+"B="]) {
    assert.throws(() => providerConfigurationKey({ ...environment, PROVIDER_CONFIG_KEY: invalid, ASSET_ACCESS_SECRET: "cannot-fallback", BETTER_AUTH_SECRET: key }), expectCode("PROVIDER_SECRET_UNAVAILABLE"))
  }
  assert.throws(() => decryptProviderSecret(one, { ...environment, PROVIDER_CONFIG_KEY: Buffer.alloc(32, 50).toString("base64") }), expectCode("PROVIDER_SECRET_UNAVAILABLE"))
})

test("版本、nonce、认证标签、密文和固定职责 AAD 均受验证", () => {
  const original = JSON.parse(encryptProviderSecret("synthetic-token", environment))
  for (const candidate of ["plain-token", "{}", JSON.stringify({ ...original, version: 2 }), JSON.stringify({ ...original, extra: true }), JSON.stringify({ ...original, nonce: Buffer.alloc(11).toString("base64") }), JSON.stringify({ ...original, tag: Buffer.alloc(16).toString("base64") }), JSON.stringify({ ...original, ciphertext: Buffer.from("changed").toString("base64") })]) {
    assert.throws(() => decryptProviderSecret(candidate, environment), expectCode("PROVIDER_SECRET_UNAVAILABLE"))
  }
  const nonce = Buffer.alloc(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce)
  cipher.setAAD(Buffer.from("other-singleton-or-purpose"))
  const ciphertext = Buffer.concat([cipher.update("synthetic-token"), cipher.final()])
  const wrongPurpose = JSON.stringify({ version: 1, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") })
  assert.throws(() => decryptProviderSecret(wrongPurpose, environment), expectCode("PROVIDER_SECRET_UNAVAILABLE"))
})

test("配置严格形状、大小、稳定 ID、名称唯一性及可为空的目录", () => {
  assert.equal(validateProviderConfiguration(input()).mappings[0].id, "stable-a")
  assert.deepEqual(validateProviderConfiguration({ ...input(), models: [], mappings: [] }).mappings, [])
  for (const invalid of [
    { ...input(), surprise: true }, { ...input(), revision: -1 }, { ...input(), revision: 1.5 },
    { ...input(), settings: { ...input().settings, apiMode: "unknown" } },
    { ...input(), modelsSynced: "true" }, { ...input(), models: [{ id: "model-a", token: "hidden" }] },
    { ...input(), models: [{ id: "model-a" }, { id: "model-a" }] },
    { ...input(), models: Array.from({ length: 5001 }, (_, i) => ({ id: `m-${i}` })) },
    { ...input(), mappings: Array.from({ length: 101 }, (_, i) => ({ id: `id-${i}`, name: `${i}`, modelId: "m" })) },
    { ...input(), mappings: [{ id: "same", name: "A", modelId: "m" }, { id: "same", name: "B", modelId: "n" }] },
    { ...input(), mappings: [{ id: "a", name: "Ａ", modelId: "m" }, { id: "b", name: "a", modelId: "n" }] },
    { ...input(), mappings: [{ id: "a", name: "bad\nname", modelId: "m" }] },
    { ...input(), extra: "x".repeat(MAX_PROVIDER_JSON_BYTES) },
  ]) assert.throws(() => validateProviderConfiguration(invalid), expectCode("INVALID_INPUT"))
})

test("保存形状验证拒绝本机/内网/查询凭据及纯掩码，不执行 DNS", () => {
  for (const baseUrl of ["http://provider.example", "https://localhost", "https://127.0.0.1", "https://10.1.2.3", "https://169.254.169.254", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://relay.internal", "https://u:p@provider.example", "https://provider.example?token=secret", "https://provider.example/#fragment"]) {
    assert.throws(() => validateProviderConfiguration({ ...input(), settings: { ...input().settings, baseUrl } }), expectCode("INVALID_INPUT"))
  }
  for (const apiKey of ["******", "••••••", "xxxxxxxx", "new\nsecret", "new\u0000secret"]) {
    assert.throws(() => validateProviderConfiguration({ ...input(), settings: { ...input().settings, apiKey } }), expectCode("INVALID_INPUT"))
  }
  assert.equal(validateProviderConfiguration({ ...input(), settings: { ...input().settings, apiKey: "" } }).settings.apiKey, "")
  assert.equal(validateProviderConfiguration({ ...input(), settings: { ...input().settings, baseUrl: "https://synthetic-never-resolve.example/v1/" } }).settings.baseUrl, "https://synthetic-never-resolve.example/v1")
})

test("空 Token 不通过地址规范化复用旧秘密，输入新 Token 才允许规范化地址", () => {
  for (const baseUrl of ["https://provider.example/v1/", " https://provider.example/v1", "https://PROVIDER.example/v1", "https://provider.example:443/v1", "https://provider.example/other/../v1"]) {
    assert.throws(() => validateProviderConfiguration({ ...input(), settings: { ...input().settings, baseUrl, apiKey: "" } }), expectCode("INVALID_INPUT"))
    assert.equal(validateProviderConfiguration({ ...input(), settings: { ...input().settings, baseUrl } }).settings.baseUrl, "https://provider.example/v1")
  }
})

test("模型设置 JSON 可到 2 MiB，认证仍默认 16 KiB，流式超限拒绝", async () => {
  const request = (body: string) => new Request("https://app.example/api/admin/provider", { method: "PUT", headers: { "Content-Type": "application/json" }, body })
  const body = JSON.stringify({ value: "x".repeat(20_000) })
  await assert.rejects(readJson(request(body)), expectCode("INVALID_INPUT"))
  assert.equal((await readJson(request(body), MAX_PROVIDER_JSON_BYTES)).value, "x".repeat(20_000))
  await assert.rejects(readJson(request(JSON.stringify({ value: "x".repeat(MAX_PROVIDER_JSON_BYTES) })), MAX_PROVIDER_JSON_BYTES), expectCode("INVALID_INPUT"))
})
