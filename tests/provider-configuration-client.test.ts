import assert from "node:assert/strict"
import { test } from "node:test"
import { ACCOUNT_SESSION_RECHECK_EVENT } from "../lib/account-client"
import { getPublicModelCatalog, ProviderConfigurationError, readAdminProviderConfiguration, saveAdminProviderConfiguration, syncProviderModels } from "../lib/provider-configuration-client"
import { ALL_ASPECT_RATIO_VALUES } from "../components/image-combiner/model-catalog"

const mapping = { id: "stable-a", name: "均衡", aspectRatios: ["square"] }
const catalog = { revision: 4, configured: true, apiMode: "images", mappings: [mapping] }
const input = { revision: 4, settings: { baseUrl: "https://synthetic.example/v1", apiKey: "", apiMode: "images" as const }, models: [], mappings: [], modelsSynced: false }

test("模型配置读取、保存和同步的权限失败统一请求会话复核，其他错误不触发", async t => {
  const target = new EventTarget()
  const original = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: target })
  t.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window") })
  let rechecks = 0
  target.addEventListener(ACCOUNT_SESSION_RECHECK_EVENT, () => rechecks++)
  let status = 401
  let code = "UNAUTHENTICATED"
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code, message: "合成权限错误" } }, { status }))
  const requests = [() => readAdminProviderConfiguration(), () => saveAdminProviderConfiguration(input), () => syncProviderModels({ revision: 4, ...input.settings })]
  for (const next of [[401, "UNAUTHENTICATED"], [403, "PASSWORD_CHANGE_REQUIRED"], [403, "FORBIDDEN"]] as const) {
    ;[status, code] = next
    for (const request of requests) await assert.rejects(request(), error => error instanceof ProviderConfigurationError && error.code === code)
  }
  assert.equal(rechecks, 9)
  status = 409
  code = "PROVIDER_REVISION_CONFLICT"
  await assert.rejects(readAdminProviderConfiguration(), ProviderConfigurationError)
  assert.equal(rechecks, 9)
})

test("公共模型目录拒绝超量、空或重复身份/名称和无效比例", async t => {
  let response: unknown = catalog
  t.mock.method(globalThis, "fetch", async () => Response.json(response))
  const badMappings = [
    Array.from({ length: 101 }, (_, index) => ({ ...mapping, id: `id-${index}`, name: `名称${index}` })),
    [{ ...mapping, id: "" }], [{ ...mapping, id: " " }], [{ ...mapping, id: " stable-a" }],
    [{ ...mapping, id: "x".repeat(129) }], [mapping, { ...mapping, name: "另一名称" }],
    [{ ...mapping, name: "" }], [{ ...mapping, name: " " }], [{ ...mapping, name: "x".repeat(41) }],
    [mapping, { ...mapping, id: "other" }], [{ ...mapping, name: "Ａ" }, { ...mapping, id: "other", name: "a" }],
    [{ ...mapping, name: "不合法\n名称" }], [{ ...mapping, aspectRatios: [] }],
    [{ ...mapping, aspectRatios: ["unsupported"] }], [{ ...mapping, aspectRatios: ["square", "square"] }],
    [{ ...mapping, aspectRatios: [NaN] }], [{ ...mapping, aspectRatios: null }],
  ]
  for (const mappings of badMappings) {
    response = { ...catalog, mappings }
    await assert.rejects(getPublicModelCatalog(), error => error instanceof ProviderConfigurationError && error.code === "INVALID_RESPONSE")
  }
  response = { ...catalog, mappings: Array.from({ length: 100 }, (_, index) => ({ ...mapping, id: `id-${index}`, name: `名称${index}`, aspectRatios: [...ALL_ASPECT_RATIO_VALUES], modelId: "must-not-propagate" })) }
  const accepted = await getPublicModelCatalog()
  assert.equal(accepted.mappings.length, 100)
  assert.deepEqual(accepted.mappings[0].aspectRatios, [...ALL_ASPECT_RATIO_VALUES])
  assert.equal(JSON.stringify(accepted).includes("must-not-propagate"), false)
})
