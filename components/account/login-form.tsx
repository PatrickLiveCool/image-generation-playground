"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AccountLoading, AccountShell } from "@/components/account/account-shell"
import { ACCOUNT_SESSION_CHANNEL, AccountRequestError, accountErrorMessage, getAccountSession, signInAccount } from "@/lib/account-client"

export function LoginForm() {
  const [checking, setChecking] = useState(true)
  const [pending, setPending] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const form = useRef<HTMLFormElement>(null)
  const password = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const recovery = useRef(false)
  const active = useRef(false)
  const version = useRef(0)
  const request = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (!active.current || busy.current) return
    const current = ++version.current
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    if (recovery.current) setPending(true)
    try {
      const { user } = await getAccountSession(controller.signal)
      if (!active.current || current !== version.current) return
      if (user) {
        form.current?.reset()
        setChecking(true)
        window.location.replace(user.mustChangePassword ? "/change-password" : "/")
      } else {
        setChecking(false)
        if (recovery.current) setError("当前没有可确认的登录会话。若使用临时密码且登录结果遗失，请联系管理员重置；也可重新检查登录状态。")
      }
    } catch (error) {
      if (!active.current || current !== version.current || controller.signal.aborted) return
      setChecking(false)
      setError(accountErrorMessage(error))
    } finally {
      if (active.current && current === version.current) setPending(false)
    }
  }, [])

  useEffect(() => {
    active.current = true
    if (new URLSearchParams(window.location.search).get("password") === "changed") {
      setNotice("密码已更新，旧会话已撤销。请使用新密码重新登录。")
    }
    void refresh()
    const onFocus = () => { void refresh() }
    const restore = (event: PageTransitionEvent) => { if (event.persisted) void refresh() }
    const clear = () => {
      ++version.current
      request.current?.abort()
      if (busy.current) {
        recovery.current = true
        setUnconfirmed(true)
        setError("登录请求已提交，结果尚未确认。请重新检查登录状态。")
      }
      busy.current = false
      setPending(false)
      if (form.current) { form.current.hidden = true; form.current.inert = true }
      setChecking(true)
    }
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(ACCOUNT_SESSION_CHANNEL)
    if (channel) channel.onmessage = onFocus
    window.addEventListener("focus", onFocus)
    window.addEventListener("pageshow", restore)
    window.addEventListener("pagehide", clear)
    return () => {
      active.current = false
      ++version.current
      request.current?.abort()
      channel?.close()
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("pageshow", restore)
      window.removeEventListener("pagehide", clear)
    }
  }, [refresh])

  useEffect(() => { if (error && !pending && !unconfirmed) password.current?.focus() }, [error, pending, unconfirmed])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || recovery.current) return
    const data = new FormData(event.currentTarget)
    const current = ++version.current
    request.current?.abort()
    busy.current = true
    setPending(true)
    setError("")
    try {
      const { user } = await signInAccount(String(data.get("username") || ""), String(data.get("password") || ""))
      if (!active.current || current !== version.current) return
      form.current?.reset()
      setChecking(true)
      window.location.replace(user?.mustChangePassword ? "/change-password" : "/")
    } catch (error) {
      if (!active.current || current !== version.current) return
      const unknown = error instanceof AccountRequestError && error.code === "SIGN_IN_UNCONFIRMED"
      recovery.current = unknown
      setUnconfirmed(unknown)
      setError(accountErrorMessage(error))
      if (password.current) password.current.value = ""
    } finally {
      if (active.current && current === version.current) {
        busy.current = false
        setPending(false)
      }
    }
  }

  return <AccountShell title="登录" description="使用管理员提供的账号登录。临时密码须在 24 小时内用于首次登录，随后设置自己的密码。">
    {checking && <AccountLoading />}
    <form ref={form} hidden={checking} inert={checking} className="space-y-5" onSubmit={submit} aria-busy={pending}>
      {notice && <p role="status" className="text-sm leading-6 text-muted-foreground">{notice}</p>}
      <div className="space-y-2"><Label htmlFor="username">用户名</Label><Input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus disabled={pending || unconfirmed} aria-describedby={error ? "login-error" : undefined} /></div>
      <div className="space-y-2"><Label htmlFor="password">密码</Label><Input ref={password} id="password" name="password" type="password" autoComplete="current-password" required disabled={pending || unconfirmed} aria-describedby={error ? "login-error" : undefined} /></div>
      <p id="login-error" role="alert" aria-live="assertive" className="text-sm leading-6 text-red-400">{error}</p>
      {unconfirmed ? <Button className="w-full" type="button" disabled={pending} onClick={() => void refresh()}>{pending ? "正在检查登录状态…" : "重新检查登录状态"}</Button> : <Button className="w-full" type="submit" disabled={pending}>{pending ? "正在登录…" : "登录"}</Button>}
      <p className="text-xs leading-5 text-muted-foreground">临时密码只能使用一次。若已使用、过期或遗失，请联系管理员明确重置。</p>
    </form>
  </AccountShell>
}
