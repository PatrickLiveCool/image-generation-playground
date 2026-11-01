import { strict as assert } from "node:assert"
import { before, after, test, type TestContext } from "node:test"
import { Window } from "happy-dom"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { AdminProviderConfiguration } from "../lib/provider-configuration-types"

const win = new Window({ url: "http://localhost/admin/models" })
const originals = new Map<string, PropertyDescriptor | undefined>()
let createRoot: typeof import("react-dom/client").createRoot
let AdminModelsManager: typeof import("../components/account/admin-models").AdminModelsManager
let AdminModels: typeof import("../components/account/admin-models").AdminModels

before(async () => {
  const values: Record<string, unknown> = {
    window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win), BroadcastChannel: undefined,
  }
  for (const name of ["HTMLElement", "HTMLInputElement", "HTMLFormElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "FocusEvent", "FormData"] as const) values[name] = win[name]
  for (const [name, value] of Object.entries(values)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import("react-dom/client"))
  ;({ AdminModelsManager, AdminModels } = await import("../components/account/admin-models"))
})

after(async () => {
  await win.happyDOM.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

const configuration: AdminProviderConfiguration = {
  revision: 4,
  settings: { baseUrl: "https://relay.example/v1", apiKey: "", apiMode: "images" },
  secretConfigured: true,
  annotationCapabilities: [],
  models: [{ id: "image-a" }, { id: "image-b" }], modelsSynced: true,
  mappings: [{ id: "a", name: "极致", modelId: "image-a" }, { id: "b", name: "均衡", modelId: "image-b" }],
}
type Reply = () => Response | Promise<Response>
const read: Reply = () => Response.json(configuration)
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function mockReplies(context: TestContext, replies: Reply[]) {
  const requests: { path: string; init: RequestInit }[] = []
  context.mock.method(globalThis, "fetch", (path: string, init: RequestInit = {}) => {
    requests.push({ path, init })
    const next = replies.shift()
    assert.ok(next, `Unexpected request ${path}`)
    return Promise.resolve().then(next)
  })
  context.after(() => assert.equal(replies.length, 0, "所有约定请求应被执行"))
  return requests
}
async function flush(action?: () => void) {
  await act(async () => { action?.(); await new Promise<void>((resolve) => setImmediate(resolve)) })
}
async function mount(context: TestContext, { gated = false, open = true } = {}) {
  const container = win.document.createElement("div")
  win.document.body.append(container)
  const root: Root = createRoot(container as unknown as HTMLElement)
  context.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    win.document.body.style.pointerEvents = ""
    win.localStorage.clear()
    win.sessionStorage.clear()
  })
  await act(async () => root.render(gated ? <AdminModels /> : <AdminModelsManager />))
  await flush()
  if (open) await flush(() => button("API 设置").click())
}
function button(text: string) {
  const result = [...win.document.querySelectorAll("button")].find((item) => item.textContent === text)
  assert.ok(result, `Missing button ${text}`)
  return result
}
function labelledButton(label: string) {
  const result = win.document.querySelector(`[aria-label="${label}"]`)
  assert.ok(result instanceof win.HTMLButtonElement, `Missing button ${label}`)
  return result
}
function input(id: string) {
  const result = win.document.getElementById(id)
  assert.ok(result instanceof win.HTMLInputElement, `Missing input ${id}`)
  return result
}
async function type(id: string, value: string) {
  await flush(() => {
    const element = input(id)
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(element, value)
    element.dispatchEvent(new win.Event("input", { bubbles: true }))
  })
}
async function mode(value: "chat" | "images") {
  await flush(() => {
    const element = win.document.getElementById("provider-api-mode")!
    assert.ok(element instanceof win.HTMLSelectElement)
    element.value = value
    element.dispatchEvent(new win.Event("change", { bubbles: true }))
  })
}
async function submit() {
  await flush(() => win.document.querySelector('[role="dialog"] form')!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })))
}
const models = () => [...win.document.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"))
const mappingOrder = () => [...win.document.querySelectorAll("[data-mapping-id]")].map((element) => element.getAttribute("data-mapping-id"))

test("后台读取安全视图，取消不保存；关闭清空新 Token 且不写浏览器存储", async (context) => {
  const requests = mockReplies(context, [read])
  await mount(context)
  assert.equal(input("provider-token").value, "")
  assert.match(win.document.body.textContent, /Token 已在服务端加密保管/)
  assert.equal(labelledButton("显示 Token").disabled, true)
  await type("provider-token", "synthetic-new-token")
  await type("mapping-a-name", "未保存名称")
  await flush(() => labelledButton("显示 Token").click())
  assert.equal(input("provider-token").type, "text")
  await flush(() => button("取消").click())
  assert.equal(win.document.querySelector('[role="dialog"]'), null)
  await flush(() => button("API 设置").click())
  assert.equal(input("provider-token").value, "")
  assert.equal(input("provider-token").type, "password")
  assert.equal(input("mapping-a-name").value, "极致")
  assert.equal(requests.length, 1)
  assert.equal(win.localStorage.length, 0)
  assert.equal(win.sessionStorage.length, 0)
})

test("同地址空 Token 保存携带 revision；服务器确认前不关闭且重复提交只发送一次", async (context) => {
  const pending = deferred<Response>()
  const requests = mockReplies(context, [read, () => pending.promise])
  await mount(context)
  await type("mapping-a-name", "清晰")
  await submit()
  assert.ok(win.document.querySelector('[role="dialog"]'))
  assert.equal(win.document.querySelector('[role="dialog"]')!.querySelector("fieldset")!.disabled, true)
  await submit()
  assert.equal(requests.length, 2)
  const body = JSON.parse(requests[1].init.body as string)
  assert.equal(requests[1].init.method, "PUT")
  assert.equal(body.revision, configuration.revision)
  assert.equal(body.settings.apiKey, "")
  assert.equal(body.mappings[0].name, "清晰")
  await flush(() => pending.resolve(Response.json({ ...configuration, revision: 5, mappings: body.mappings })))
  assert.equal(win.document.querySelector('[role="dialog"]'), null)
  assert.match(win.document.body.textContent, /配置已保存/)
})

test("保存失败保留输入和映射，允许继续编辑后显式保存", async (context) => {
  const requests = mockReplies(context, [read,
    () => Response.json({ error: { code: "INVALID_CONFIGURATION", message: "合成校验失败" } }, { status: 400 }),
    () => Response.json({ ...configuration, revision: 5 }),
  ])
  await mount(context)
  await type("provider-token", "synthetic-secret")
  await type("mapping-a-name", "第一次草稿")
  await submit()
  assert.ok(win.document.querySelector('[role="dialog"]'))
  assert.equal(input("provider-token").value, "synthetic-secret")
  assert.equal(input("mapping-a-name").value, "第一次草稿")
  assert.equal(win.document.querySelector('[role="dialog"]')!.querySelector("fieldset")!.disabled, false)
  assert.match(win.document.body.textContent, /合成校验失败/)
  await type("mapping-a-name", "第二次草稿")
  await submit()
  assert.equal(JSON.parse(requests[2].init.body as string).mappings[0].name, "第二次草稿")
})

test("更换地址的空 Token 在同步和保存前拒绝；输入新 Token 后提交新地址", async (context) => {
  const requests = mockReplies(context, [read, () => Response.json({ ...configuration, revision: 5 })])
  await mount(context)
  await type("provider-base-url", "https://other.example/v1")
  await flush(() => button("同步模型").click())
  await submit()
  assert.equal(requests.length, 1)
  assert.match(win.document.body.textContent, /更换 Base URL 后，请输入该地址对应的新 Token/)
  await type("provider-token", "synthetic-other-secret")
  await submit()
  const body = JSON.parse(requests[1].init.body as string)
  assert.equal(body.settings.baseUrl, "https://other.example/v1")
  assert.equal(body.settings.apiKey, "synthetic-other-secret")
})

test("首次配置必须输入 Token，首次保存使用 revision 0", async (context) => {
  const requests = mockReplies(context, [
    () => Response.json({ ...configuration, revision: 0, secretConfigured: false, settings: { ...configuration.settings, baseUrl: "" }, models: [], mappings: [], modelsSynced: false }),
    () => Response.json({ ...configuration, revision: 1 }),
  ])
  await mount(context)
  await type("provider-base-url", configuration.settings.baseUrl)
  await submit()
  assert.equal(requests.length, 1)
  assert.match(win.document.body.textContent, /请填写 API Token/)
  await type("provider-token", "synthetic-first-token")
  await submit()
  assert.equal(JSON.parse(requests[1].init.body as string).revision, 0)
  assert.equal(JSON.parse(requests[1].init.body as string).settings.apiKey, "synthetic-first-token")
})

test("地址原样匹配才可复用已配置 Token，末尾斜杠和大小写改动也要求新 Token", async (context) => {
  const requests = mockReplies(context, [read])
  await mount(context)
  for (const baseUrl of [configuration.settings.baseUrl + "/", configuration.settings.baseUrl.replace("relay", "RELAY")]) {
    await type("provider-base-url", baseUrl)
    await flush(() => button("同步模型").click())
    await submit()
    assert.equal(requests.length, 1)
    assert.match(win.document.body.textContent, /更换 Base URL 后，请输入该地址对应的新 Token/)
  }
})

test("草稿同步使用 revision/apiMode 与空 Token，不保存配置；名称和顺序保留", async (context) => {
  const requests = mockReplies(context, [read, () => Response.json({ models: [{ id: "image-new" }] })])
  await mount(context)
  await type("mapping-a-name", "手填名称")
  await flush(() => labelledButton("下移映射 1").click())
  await mode("chat")
  await flush(() => button("同步模型").click())
  assert.deepEqual(JSON.parse(requests[1].init.body as string), { revision: 4, baseUrl: configuration.settings.baseUrl, apiKey: "", apiMode: "chat" })
  assert.equal(requests[1].path, "/api/provider/models")
  assert.equal(requests[1].init.method, "POST")
  assert.deepEqual(mappingOrder(), ["b", "a"])
  assert.equal(input("mapping-a-name").value, "手填名称")
  assert.deepEqual(models(), ["image-new"])
  assert.match(win.document.body.textContent, /此模型未出现在最近同步的列表中/)
  await flush(() => button("取消").click())
  await flush(() => button("API 设置").click())
  assert.deepEqual(models(), ["image-a", "image-b"])
  assert.deepEqual(mappingOrder(), ["a", "b"])
  assert.equal(requests.filter(({ init }) => init.method === "PUT").length, 0)
})

test("地址、Token、接口类型变化以及新同步均取消旧请求，迟到返回不能覆盖当前模型", async (context) => {
  const first = deferred<Response>(), second = deferred<Response>(), third = deferred<Response>(), fourth = deferred<Response>()
  const requests = mockReplies(context, [read, () => first.promise, () => second.promise, () => third.promise, () => fourth.promise,
    () => Response.json({ models: [{ id: "latest-model" }] }),
  ])
  await mount(context)
  await flush(() => button("同步模型").click())
  await type("provider-base-url", "https://other.example/v1")
  assert.equal(requests[1].init.signal!.aborted, true)
  await type("provider-token", "synthetic-other-token")
  await flush(() => button("同步模型").click())
  await type("provider-token", "synthetic-replaced-token")
  assert.equal(requests[2].init.signal!.aborted, true)
  await flush(() => button("同步模型").click())
  await mode("chat")
  assert.equal(requests[3].init.signal!.aborted, true)
  await flush(() => button("同步模型").click())
  await flush(() => button("重新同步").click())
  assert.equal(requests[4].init.signal!.aborted, true)
  assert.deepEqual(models(), ["latest-model"])
  await flush(() => { for (const old of [first, second, third, fourth]) old.resolve(Response.json({ models: [{ id: "stale-model" }] })) })
  assert.deepEqual(models(), ["latest-model"])
  assert.equal(input("provider-token").value, "synthetic-replaced-token")
})

test("关闭和重新打开使在途同步失效，新草稿不受迟到响应影响", async (context) => {
  const pending = deferred<Response>()
  const requests = mockReplies(context, [read, () => pending.promise])
  await mount(context)
  await type("provider-token", "synthetic-unsaved-token")
  await flush(() => button("同步模型").click())
  await flush(() => button("取消").click())
  assert.equal(requests[1].init.signal!.aborted, true)
  await flush(() => button("API 设置").click())
  await flush(() => pending.resolve(Response.json({ models: [{ id: "stale-model" }] })))
  assert.deepEqual(models(), ["image-a", "image-b"])
  assert.equal(input("provider-token").value, "")
})

test("网络结果不明不自动重发；重新载入失败仍保留草稿，成功后才采用服务端版本", async (context) => {
  const reread = deferred<Response>()
  const requests = mockReplies(context, [read,
    () => { throw new Error("synthetic connection lost") },
    () => { throw new Error("synthetic read failure") },
    () => reread.promise,
  ])
  await mount(context)
  await type("provider-token", "synthetic-pending-token")
  await type("mapping-a-name", "未确认草稿")
  await submit()
  assert.equal(requests.length, 2)
  assert.equal(input("provider-token").value, "synthetic-pending-token")
  assert.equal(input("mapping-a-name").value, "未确认草稿")
  assert.equal(button("保存配置").disabled, true)
  await submit()
  assert.equal(requests.length, 2)
  await flush(() => button("重新载入核对").click())
  assert.equal(input("provider-token").value, "synthetic-pending-token")
  assert.equal(input("mapping-a-name").value, "未确认草稿")
  await flush(() => button("重新载入核对").click())
  assert.equal(input("mapping-a-name").value, "未确认草稿")
  await flush(() => reread.resolve(Response.json({ ...configuration, revision: 5, mappings: [{ id: "a", name: "已提交名称", modelId: "image-a" }] })))
  assert.equal(input("mapping-a-name").value, "已提交名称")
  assert.equal(input("provider-token").value, "")
  assert.equal(button("保存配置").disabled, false)
  assert.equal(requests.filter(({ init }) => init.method === "PUT").length, 1)
})

test("409 版本冲突保留草稿且关闭重开不能绕过重新载入核对", async (context) => {
  const requests = mockReplies(context, [read, () => Response.json({ error: { code: "REVISION_CONFLICT", message: "配置已被其他管理员更新" } }, { status: 409 })])
  await mount(context)
  await type("mapping-a-name", "冲突草稿")
  await submit()
  assert.match(win.document.body.textContent, /配置已被其他管理员更新/)
  assert.equal(input("mapping-a-name").value, "冲突草稿")
  assert.equal(button("保存配置").disabled, true)
  await flush(() => button("取消").click())
  await flush(() => button("API 设置").click())
  assert.equal(button("保存配置").disabled, true)
  await submit()
  assert.equal(requests.length, 2)
})

test("同步版本冲突保留草稿并进入重新载入流程，不自动同步或保存", async (context) => {
  const requests = mockReplies(context, [read,
    () => Response.json({ error: { code: "PROVIDER_REVISION_CONFLICT", message: "版本已更新" } }, { status: 409 }),
    () => { throw new Error("synthetic read failure") },
    () => Response.json({ ...configuration, revision: 5 }),
    () => Response.json({ models: [{ id: "current-model" }] }),
  ])
  await mount(context)
  await type("mapping-a-name", "冲突中的草稿")
  await flush(() => button("同步模型").click())
  assert.equal(input("mapping-a-name").value, "冲突中的草稿")
  assert.match(win.document.body.textContent, /当前草稿已保留/)
  assert.equal(button("保存配置").disabled, true)
  assert.equal(button("同步模型").disabled, true)
  await submit()
  assert.equal(requests.length, 2)
  await flush(() => button("重新载入核对").click())
  assert.equal(input("mapping-a-name").value, "冲突中的草稿")
  await flush(() => button("重新载入核对").click())
  assert.equal(input("mapping-a-name").value, "极致")
  assert.equal(button("同步模型").disabled, false)
  await flush(() => button("同步模型").click())
  assert.equal(JSON.parse(requests[4].init.body as string).revision, 5)
  assert.equal(requests.filter(({ init }) => init.method === "PUT").length, 0)
})

test("映射达到100条禁用添加，删除一条后恢复添加", async (context) => {
  mockReplies(context, [() => Response.json({ ...configuration, mappings: Array.from({ length: 100 }, (_, index) => ({ id: `limit-${index}`, name: `名称${index}`, modelId: "image-a" })) })])
  await mount(context)
  assert.equal(button("添加映射").disabled, true)
  assert.match(win.document.body.textContent, /最多添加 100 条映射/)
  await flush(() => button("添加映射").click())
  assert.equal(mappingOrder().length, 100)
  await flush(() => labelledButton("删除映射 1").click())
  assert.equal(button("添加映射").disabled, false)
  await flush(() => button("添加映射").click())
  assert.equal(mappingOrder().length, 100)
  assert.equal(button("添加映射").disabled, true)
})

const admin = { id: "synthetic-admin", username: "admin", name: "合成管理员", role: "admin", mustChangePassword: false }
for (const operation of ["read", "save", "sync"] as const) {
  test(`${operation}权限失败触发AccountGate复核并隐藏后台及弹窗`, async context => {
    const recheck = deferred<Response>()
    const redirects: string[] = []
    context.mock.method(win.location, "replace", (url: string) => { redirects.push(url) })
    const code = operation === "read" ? "UNAUTHENTICATED" : operation === "save" ? "PASSWORD_CHANGE_REQUIRED" : "FORBIDDEN"
    const failure: Reply = () => Response.json({ error: { code, message: "合成权限失败" } }, { status: operation === "read" ? 401 : 403 })
    const requests = mockReplies(context, [() => Response.json({ user: admin }), ...(operation === "read" ? [] : [read]), failure, () => recheck.promise])
    await mount(context, { gated: true, open: operation !== "read" })
    if (operation === "save") await submit()
    if (operation === "sync") await flush(() => button("同步模型").click())
    await flush()
    assert.equal(win.document.querySelector("[data-account-content]")!.hasAttribute("hidden"), true)
    assert.equal(win.document.querySelector('[role="dialog"]'), null)
    assert.equal(requests.at(-1)!.path, "/api/account/session")
    await flush(() => recheck.resolve(Response.json({ user: operation === "read" ? null : operation === "save" ? { ...admin, mustChangePassword: true } : { ...admin, role: "user" } })))
    if (operation === "sync") assert.match(win.document.body.textContent, /当前账号无权访问管理后台/)
    else assert.deepEqual(redirects, [operation === "read" ? "/login" : "/change-password"])
    assert.equal(win.document.querySelector('[role="dialog"]'), null)
  })
}

test("保存超时覆盖完整响应正文，超时后迟到成功响应也不会关闭草稿或重试", async (context) => {
  const body = deferred<unknown>()
  const response = Response.json({})
  context.mock.method(response, "json", () => body.promise)
  const requests = mockReplies(context, [read, () => response])
  await mount(context)
  await type("mapping-a-name", "等待确认的名称")
  context.mock.timers.enable({ apis: ["setTimeout"] })
  await submit()
  assert.equal(win.document.querySelector('[role="dialog"]')!.querySelector("fieldset")!.disabled, true)
  await flush(() => context.mock.timers.tick(15_000))
  assert.match(win.document.body.textContent, /请求超时/)
  assert.equal(requests[1].init.signal!.aborted, true)
  assert.equal(win.document.querySelector('[role="dialog"]')!.querySelector("fieldset")!.disabled, false)
  assert.equal(input("mapping-a-name").value, "等待确认的名称")
  assert.equal(button("保存配置").disabled, true)
  await flush(() => body.resolve({ ...configuration, revision: 5 }))
  assert.ok(win.document.querySelector('[role="dialog"]'))
  assert.equal(input("mapping-a-name").value, "等待确认的名称")
  assert.equal(requests.length, 2)
})

async function fillEvidence() {
  await type("provider-annotation-reference", "https://docs.example/two-images")
  await flush(() => {
    const textarea = win.document.getElementById("provider-annotation-note")!
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "已核对当前连接、接口、实际模型及 Token 权限的双图输入契约。")
    textarea.dispatchEvent(new win.Event("input", { bubbles: true }))
  })
  await flush(() => {
    const checkbox = win.document.querySelector('form[aria-label="记录批注输入能力"] input[type="checkbox"]')!
    assert.ok(checkbox instanceof win.HTMLInputElement)
    checkbox.click()
  })
}
async function submitEvidence() {
  await flush(() => win.document.querySelector('form[aria-label="记录批注输入能力"]')!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })))
}
const recordedConfiguration = {
  ...configuration, revision: 5, annotationCapabilities: [{ mappingId: "a", expression: "overlay-v1", maxInputImages: 2, configurationRevision: 5,
    bindingSha256: "1".repeat(64), evidenceSha256: "2".repeat(64), evidence: { id: "11111111-1111-4111-8111-111111111111", actorId: "synthetic-admin", recordedAt: "2026-10-30T00:00:00.000Z", reference: "https://docs.example/two-images", note: "输入契约记录", confirmed: true } }],
}

test("批注能力只能针对已保存配置独立记录，不能在未保存设置中标为已核验", async context => {
  const pending = deferred<Response>()
  const requests = mockReplies(context, [read, () => pending.promise])
  await mount(context)
  assert.equal(win.document.querySelector('form[aria-label="记录批注输入能力"] fieldset')!.hasAttribute("disabled"), true)
  await type("mapping-a-name", "未保存模型名")
  await type("mapping-a-model", "unconfirmed-model")
  await submitEvidence()
  assert.equal(requests.length, 1)
  assert.match(win.document.body.textContent, /先保存 API 设置/)
  await flush(() => button("取消").click())
  await fillEvidence()
  await submitEvidence()
  await submitEvidence()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].path, "/api/admin/provider/annotation-capabilities")
  assert.equal(requests[1].init.method, "POST")
  const sent = JSON.parse(requests[1].init.body as string)
  assert.deepEqual(Object.keys(sent).sort(), ["confirmed", "evidenceNote", "evidenceReference", "mappingId", "revision"])
  assert.equal(sent.revision, 4)
  assert.equal(sent.mappingId, "a")
  assert.equal(sent.confirmed, true)
  assert.equal(button("API 设置").disabled, true)
  assert.equal(button("刷新").disabled, true)
  await flush(() => pending.resolve(Response.json(recordedConfiguration)))
  assert.match(win.document.body.textContent, /极致：已记录双图输入契约/)
  assert.match(win.document.body.textContent, /未调用模型，真实编辑效果仍需另行验收/)
  assert.equal(input("provider-annotation-reference").value, "")
  assert.equal(win.localStorage.length, 0)
})

test("证据记录结果不明时保留输入并要求只读核对，不自动重发", async context => {
  const requests = mockReplies(context, [read, () => { throw new Error("synthetic lost response") }, () => Response.json(recordedConfiguration)])
  await mount(context, { open: false })
  await fillEvidence()
  await submitEvidence()
  assert.match(win.document.body.textContent, /结果尚未确认/)
  assert.equal(input("provider-annotation-reference").value, "https://docs.example/two-images")
  assert.equal(win.document.querySelector('form[aria-label="记录批注输入能力"] fieldset')!.hasAttribute("disabled"), true)
  await submitEvidence()
  assert.equal(requests.length, 2)
  await flush(() => button("刷新").click())
  assert.match(win.document.body.textContent, /极致：已记录双图输入契约/)
  assert.equal(requests.filter(request => request.init.method === "POST").length, 1)
  assert.equal(button("记录输入契约").disabled, true, "读取新配置后须重新明确确认")
})

test("独立停用按钮可键盘聚焦且仅提交已保存revision，保留普通配置与公开状态", async context => {
  const pending = deferred<Response>()
  const requests = mockReplies(context, [() => Response.json(recordedConfiguration), () => pending.promise])
  await mount(context, { open: false })
  const disable = button("停用批注能力")
  assert.equal(disable.getAttribute("type"), "button")
  await flush(() => disable.focus())
  assert.equal(win.document.activeElement, disable)
  assert.equal(disable.getAttribute("aria-describedby"), "annotation-disable-help")
  assert.match(win.document.getElementById("annotation-disable-help")!.textContent, /普通生成和已受理任务保留/)
  await flush(() => disable.click())
  await flush(() => disable.click())
  assert.equal(requests.length, 2)
  assert.equal(requests[1].init.method, "DELETE")
  assert.deepEqual(JSON.parse(requests[1].init.body as string), { revision: 5, mappingId: "a" })
  assert.equal(button("API 设置").disabled, true)
  await flush(() => pending.resolve(Response.json({ ...recordedConfiguration, revision: 6, annotationCapabilities: [] })))
  assert.match(win.document.body.textContent, /极致：未启用，批注不可用/)
  assert.match(win.document.querySelector('[role="status"]')!.textContent, /普通生成仍可使用，已受理任务保留原能力证据/)
  assert.equal([...win.document.querySelectorAll("button")].some(item => item.textContent === "停用批注能力"), false)
  assert.match(win.document.body.textContent, /https:\/\/relay.example\/v1/)
  assert.equal(button("API 设置").disabled, false)
})

test("停用冲突保留已知证据并禁用重试，刷新核对后才显示新状态", async context => {
  const requests = mockReplies(context, [() => Response.json(recordedConfiguration),
    () => Response.json({ error: { code: "PROVIDER_REVISION_CONFLICT", message: "配置版本已变更" } }, { status: 409 }),
    () => Response.json({ ...recordedConfiguration, revision: 6, annotationCapabilities: [] }),
  ])
  await mount(context, { open: false })
  await flush(() => button("停用批注能力").click())
  assert.match(win.document.body.textContent, /配置版本已变更/)
  assert.match(win.document.body.textContent, /当前证据 11111111/)
  assert.equal(win.document.querySelector('form[aria-label="记录批注输入能力"] fieldset')!.hasAttribute("disabled"), true)
  await flush(() => button("停用批注能力").click())
  assert.equal(requests.length, 2)
  await flush(() => button("刷新").click())
  assert.match(win.document.body.textContent, /极致：未启用，批注不可用/)
  assert.equal(requests.filter(item => item.init.method === "DELETE").length, 1)
})
