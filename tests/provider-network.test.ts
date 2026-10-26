import { strict as assert } from "node:assert"
import { test } from "node:test"
import dns from "node:dns/promises"
import https from "node:https"
import { syncBuiltinESMExports } from "node:module"
import { PassThrough } from "node:stream"
// @ts-expect-error Node's built-in TypeScript runner requires the file extension.
import { endpointUrl, isPublicAddress, normalizeBaseUrl, ProviderError, publicFetch, validateProviderSettings } from "../lib/provider-network.ts"

test("keeps the configured relay path and never guesses an API version", () => {
  assert.equal(normalizeBaseUrl(" https://relay.example/custom/v1/// "), "https://relay.example/custom/v1")
  assert.equal(endpointUrl("https://relay.example/custom/v1/", "images/generations"), "https://relay.example/custom/v1/images/generations")
  assert.equal(endpointUrl("https://relay.example", "models"), "https://relay.example/models")
})

test("rejects credentials, query parameters, fragments and non-HTTPS URLs", () => {
  for (const url of ["http://relay.example/v1", "https://secret@relay.example/v1", "https://relay.example/v1?token=secret", "https://relay.example/v1#secret", "file:///etc/hosts", ""]) {
    assert.throws(() => normalizeBaseUrl(url), ProviderError)
  }
  assert.throws(() => endpointUrl("https://relay.example", "../private"), ProviderError)
})

test("blocks local, mapped, transition and reserved addresses", () => {
  for (const address of ["0.0.0.0", "10.2.3.4", "100.64.1.2", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.254", "192.168.1.1", "192.0.2.3", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "2001::1", "3fff::1"]) {
    assert.equal(isPublicAddress(address), false, address)
  }
  for (const url of ["https://127.1", "https://2130706433", "https://0x7f000001", "https://[::ffff:127.0.0.1]", "https://localhost", "https://service.local"]) {
    assert.throws(() => normalizeBaseUrl(url), ProviderError, url)
  }
})

test("accepts publicly routable IPv4 and IPv6", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(address), true, address)
  }
})

test("validates required credentials and protocol without exposing the token", () => {
  assert.deepEqual(validateProviderSettings({ baseUrl: "https://relay.example/v1/", apiKey: " token " }), {
    baseUrl: "https://relay.example/v1", apiKey: "token", apiMode: "images",
  })
  for (const apiKey of ["", "  ", "token\r\nInjected: true", "x".repeat(4097)]) {
    assert.throws(() => validateProviderSettings({ baseUrl: "https://relay.example", apiKey }), ProviderError)
  }
  assert.throws(() => validateProviderSettings({ baseUrl: "https://relay.example", apiKey: "test", apiMode: "unknown" }), ProviderError)
})

test("rejects private fetch destinations before opening a connection", async () => {
  await assert.rejects(publicFetch("https://169.254.169.254/latest/meta-data"), ProviderError)
  await assert.rejects(publicFetch("https://[::ffff:127.0.0.1]/"), ProviderError)
})

test("an already aborted caller cancels before DNS or request", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(publicFetch("https://relay.example/v1/models", { signal: controller.signal }), { name: "AbortError" })
})

test("pins the vetted DNS address while retaining relay Host and TLS identity", async (context) => {
  context.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }])
  let options: https.RequestOptions | undefined
  const requestMock = context.mock.method(https, "request", ((requestOptions: https.RequestOptions, callback: (response: unknown) => void) => {
    options = requestOptions
    return {
      on() { return this },
      end() {
        const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/json" } })
        callback(response)
        response.end('{"data":[]}')
      },
    }
  }) as unknown as typeof https.request)
  syncBuiltinESMExports()
  try {
    const response = await publicFetch("https://relay.example/custom/v1/models", { headers: { Authorization: "Bearer test-token" } })
    assert.deepEqual(await response.json(), { data: [] })
    assert.equal(options?.hostname, "8.8.8.8")
    assert.equal(options?.servername, "relay.example")
    assert.equal((options?.headers as Record<string, string>).host, "relay.example")
    assert.equal(options?.path, "/custom/v1/models")
    assert.equal(requestMock.mock.callCount(), 1)
  } finally {
    context.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test("refuses a DNS result containing both public and private addresses", async (context) => {
  context.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }])
  const requestMock = context.mock.method(https, "request", () => { throw new Error("must not connect") })
  syncBuiltinESMExports()
  try {
    await assert.rejects(publicFetch("https://relay.example/v1/models"), ProviderError)
    assert.equal(requestMock.mock.callCount(), 0)
  } finally {
    context.mock.restoreAll()
    syncBuiltinESMExports()
  }
})
