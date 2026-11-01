import { strict as assert } from "node:assert"
import { before, after, test, type TestContext } from "node:test"
import { Window } from "happy-dom"
import { act, useEffect, useState, type ReactNode } from "react"
import type { Root } from "react-dom/client"
import type { AccountUser } from "../lib/account-types"

const win = new Window({ url: "http://localhost/login" })
const originals = new Map<string, PropertyDescriptor | undefined>()
let createRoot: typeof import("react-dom/client").createRoot
let LoginForm: typeof import("../components/account/login-form").LoginForm
let ChangePasswordForm: typeof import("../components/account/change-password-form").ChangePasswordForm
let AccountGate: typeof import("../components/account/account-gate").AccountGate
let Dialog: typeof import("../components/ui/dialog").Dialog
let DialogContent: typeof import("../components/ui/dialog").DialogContent
let DialogTitle: typeof import("../components/ui/dialog").DialogTitle
let DialogDescription: typeof import("../components/ui/dialog").DialogDescription

before(async () => {
  const values: Record<string, unknown> = {
    window: win, document: win.document, navigator: win.navigator,
    IS_REACT_ACT_ENVIRONMENT: true, BroadcastChannel: undefined,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  }
  for (const name of ["HTMLElement", "HTMLInputElement", "HTMLFormElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "FocusEvent", "FormData"] as const) values[name] = win[name]
  for (const [name, value] of Object.entries(values)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import("react-dom/client"))
  ;({ LoginForm } = await import("../components/account/login-form"))
  ;({ ChangePasswordForm } = await import("../components/account/change-password-form"))
  ;({ AccountGate } = await import("../components/account/account-gate"))
  ;({ Dialog, DialogContent, DialogTitle, DialogDescription } = await import("../components/ui/dialog"))
})

after(async () => {
  await win.happyDOM.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

const user: AccountUser = { id: "account-a", username: "sample", name: "合成用户A", role: "user", mustChangePassword: false }
const tempUser: AccountUser = { ...user, mustChangePassword: true }
const otherUser: AccountUser = { ...user, id: "account-b", username: "other", name: "合成用户B" }
type Reply = () => Response | Promise<Response>
const session = (value: AccountUser | null): Reply => () => Response.json({ user: value })
const ok: Reply = () => Response.json({ ok: true })
const offline: Reply = () => { throw new Error("offline") }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
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
async function mount(context: TestContext, child: ReactNode) {
  const redirects: string[] = []
  context.mock.method(win.location, "replace", (url: string) => { redirects.push(url) })
  const container = win.document.createElement("div")
  win.document.body.append(container)
  const root: Root = createRoot(container as unknown as HTMLElement)
  context.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    win.document.body.style.pointerEvents = ""
  })
  await act(async () => root.render(child))
  await flush()
  return { container, redirects }
}
function input(name: string) {
  const result = win.document.querySelector(`input[name="${name}"]`)
  assert.ok(result instanceof win.HTMLInputElement, `Missing input ${name}`)
  return result
}
function button(text: string) {
  const result = [...win.document.querySelectorAll("button")].find((item) => item.textContent === text)
  assert.ok(result, `Missing button ${text}`)
  return result
}
const focus = () => win.dispatchEvent(new win.Event("focus"))

test("登录页窗口focus复核匿名身份不替换表单或清空输入", async (context) => {
  const pending = deferred<Response>()
  mockReplies(context, [session(null), () => pending.promise])
  await mount(context, <LoginForm />)
  const username = input("username")
  const password = input("password")
  username.value = "unsubmitted-user"
  password.value = "unsubmitted-password"
  await flush(focus)
  assert.equal(input("password"), password)
  assert.equal(password.value, "unsubmitted-password")
  await flush(() => pending.resolve(Response.json({ user: null })))
  assert.equal(input("username"), username)
  assert.equal(username.value, "unsubmitted-user")
  assert.equal(password.value, "unsubmitted-password")
})

test("改密页focus复核同账号保留所有密码；确认换号后清空旧表单", async (context) => {
  mockReplies(context, [session(tempUser), session(tempUser), session(otherUser)])
  const { redirects } = await mount(context, <ChangePasswordForm />)
  const current = input("currentPassword")
  current.value = "old synthetic password"
  input("newPassword").value = "new synthetic password"
  input("confirmPassword").value = "new synthetic password"
  await flush(focus)
  assert.equal(input("currentPassword"), current)
  assert.equal(current.value, "old synthetic password")
  assert.equal(input("newPassword").value, "new synthetic password")
  assert.equal(input("confirmPassword").value, "new synthetic password")
  await flush(focus)
  assert.equal(win.document.querySelector("form"), null)
  assert.equal(current.value, "")
  assert.deepEqual(redirects, ["/change-password"])
})

test("一次性密码提交成功后会话断网，重试仅查询session并恢复登录", async (context) => {
  const requests = mockReplies(context, [session(null), ok, offline, session(tempUser)])
  const { redirects } = await mount(context, <LoginForm />)
  input("username").value = user.username
  input("password").value = "one-time synthetic password"
  await flush(() => win.document.querySelector("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })))
  assert.equal(input("username").disabled, true)
  assert.equal(input("password").disabled, true)
  assert.match(win.document.body.textContent, /登录请求已提交/)
  await flush(() => button("重新检查登录状态").click())
  assert.deepEqual(redirects, ["/change-password"])
  assert.equal(requests.filter(({ init }) => init.method === "POST").length, 1)
  assert.deepEqual(requests.map(({ path }) => path), ["/api/account/session", "/api/auth/sign-in/username", "/api/account/session", "/api/account/session"])
})

function lifecycle() {
  const counts = { mounts: 0, unmounts: 0 }
  function Workspace() {
    const [draft, setDraft] = useState("initial draft")
    useEffect(() => { counts.mounts += 1; return () => { counts.unmounts += 1 } }, [])
    return <><input name="draft" value={draft} readOnly /><button onClick={() => setDraft("unsaved draft")}>编辑草稿</button></>
  }
  return { counts, Workspace }
}

test("Gate临时断网与同身份复核保留工作区实例，隐藏且inert，重试恢复", async (context) => {
  mockReplies(context, [session(user), offline, session(user)])
  const { Workspace, counts } = lifecycle()
  const { container } = await mount(context, <AccountGate>{() => <Workspace />}</AccountGate>)
  await flush(() => button("编辑草稿").click())
  const original = input("draft")
  await flush(focus)
  const boundary = container.querySelector("[data-account-content]")!
  assert.equal(boundary.hasAttribute("hidden"), true)
  assert.equal(boundary.hasAttribute("inert"), true)
  assert.equal(input("draft"), original)
  assert.equal(input("draft").value, "unsaved draft")
  assert.deepEqual(counts, { mounts: 1, unmounts: 0 })
  await flush(() => button("重新检查登录状态").click())
  assert.equal(boundary.hasAttribute("hidden"), false)
  assert.equal(boundary.hasAttribute("inert"), false)
  assert.equal(input("draft"), original)
  assert.equal(input("draft").value, "unsaved draft")
  assert.deepEqual(counts, { mounts: 1, unmounts: 0 })
})

test("Gate确认换号立即卸载旧画面，较早GET迟到不得恢复旧会话", async (context) => {
  const old = deferred<Response>()
  mockReplies(context, [session(user), () => old.promise, session(otherUser)])
  const { Workspace, counts } = lifecycle()
  const { redirects } = await mount(context, <AccountGate>{() => <Workspace />}</AccountGate>)
  await flush(focus)
  await flush(focus)
  assert.equal(win.document.querySelector('[name="draft"]'), null)
  assert.deepEqual(counts, { mounts: 1, unmounts: 1 })
  assert.deepEqual(redirects, ["/"])
  await flush(() => old.resolve(Response.json({ user })))
  assert.equal(win.document.querySelector('[name="draft"]'), null)
  assert.deepEqual(redirects, ["/"])
})

test("Gate退出开始隐藏并保留实例，失败后确认同会话再恢复", async (context) => {
  const logout = deferred<Response>()
  mockReplies(context, [session(user), () => logout.promise, session(user)])
  const { Workspace, counts } = lifecycle()
  const { container, redirects } = await mount(context, <AccountGate>{() => <Workspace />}</AccountGate>)
  const original = input("draft")
  await flush(() => button("退出").click())
  assert.equal(container.querySelector("[data-account-content]")?.hasAttribute("hidden"), true)
  assert.equal(container.querySelector("[data-account-content]")?.hasAttribute("inert"), true)
  assert.deepEqual(counts, { mounts: 1, unmounts: 0 })
  await flush(() => logout.reject(new Error("offline")))
  assert.equal(input("draft"), original)
  assert.equal(container.querySelector("[data-account-content]")?.hasAttribute("hidden"), false)
  assert.match(container.textContent, /退出未能确认/)
  assert.deepEqual(counts, { mounts: 1, unmounts: 0 })
  assert.deepEqual(redirects, [])
})

test("Gate确认退出清空旧内容，退出前较早GET迟到不得恢复", async (context) => {
  const old = deferred<Response>()
  const logout = deferred<Response>()
  mockReplies(context, [session(user), () => old.promise, () => logout.promise])
  const { Workspace, counts } = lifecycle()
  const { redirects } = await mount(context, <AccountGate>{() => <Workspace />}</AccountGate>)
  // Both events are dispatched before React commits the checking boundary.
  await flush(() => { focus(); button("退出").click() })
  await flush(() => logout.resolve(Response.json({ ok: true })))
  assert.equal(win.document.querySelector('[name="draft"]'), null)
  assert.deepEqual(redirects, ["/login"])
  await flush(() => old.resolve(Response.json({ user })))
  assert.equal(win.document.querySelector('[name="draft"]'), null)
  assert.deepEqual(counts, { mounts: 1, unmounts: 1 })
})

test("Gate服务端确认会话失效后卸载工作区并跳转登录", async (context) => {
  mockReplies(context, [session(user), session(null)])
  const { Workspace, counts } = lifecycle()
  const { redirects } = await mount(context, <AccountGate>{() => <Workspace />}</AccountGate>)
  await flush(focus)
  assert.equal(win.document.querySelector('[name="draft"]'), null)
  assert.deepEqual(counts, { mounts: 1, unmounts: 1 })
  assert.deepEqual(redirects, ["/login"])
})

test("改密页临时断网隐藏但保留表单，恢复后输入仍在", async (context) => {
  mockReplies(context, [session(tempUser), offline, session(tempUser)])
  await mount(context, <ChangePasswordForm />)
  const current = input("currentPassword")
  current.value = "unsubmitted old password"
  input("newPassword").value = "unsubmitted new password"
  await flush(focus)
  const form = win.document.querySelector("form")!
  assert.equal(form.hidden, true)
  assert.equal(form.hasAttribute("inert"), true)
  assert.equal(input("currentPassword"), current)
  await flush(() => button("重新检查登录状态").click())
  assert.equal(form.hidden, false)
  assert.equal(current.value, "unsubmitted old password")
  assert.equal(input("newPassword").value, "unsubmitted new password")
})

test("Gate隐藏时关闭Portal弹窗交互，恢复同身份后仍显示原临时密码", async (context) => {
  mockReplies(context, [session(user), offline, session(user)])
  const counts = { mounts: 0, unmounts: 0 }
  function PasswordResult() {
    const [credential] = useState("Synthetic temporary password 123")
    const [open, setOpen] = useState(true)
    useEffect(() => { counts.mounts += 1; return () => { counts.unmounts += 1 } }, [])
    return <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogTitle>本次临时密码</DialogTitle><DialogDescription>合成测试凭据</DialogDescription><input name="temporary" value={credential} readOnly /></DialogContent></Dialog>
  }
  await mount(context, <AccountGate>{() => <PasswordResult />}</AccountGate>)
  assert.equal(input("temporary").value, "Synthetic temporary password 123")
  await flush(focus)
  assert.equal(win.document.querySelector('[role="dialog"]'), null)
  assert.deepEqual(counts, { mounts: 1, unmounts: 0 })
  await flush(() => button("重新检查登录状态").click())
  assert.equal(input("temporary").value, "Synthetic temporary password 123")
  assert.deepEqual(counts, { mounts: 1, unmounts: 0 })
})
