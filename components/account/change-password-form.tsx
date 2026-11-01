"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AccountLoading, AccountShell } from "@/components/account/account-shell"
import { ACCOUNT_SESSION_CHANNEL, accountErrorMessage, changeAccountPassword, getAccountSession, signOutAccount } from "@/lib/account-client"
import type { AccountUser } from "@/lib/account-types"

export function ChangePasswordForm() {
  const [user, setUser] = useState<AccountUser | null>(null)
  const [checking, setChecking] = useState(true)
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [sessionError, setSessionError] = useState("")
  const form = useRef<HTMLFormElement>(null)
  const currentPassword = useRef<HTMLInputElement>(null)
  const confirmPassword = useRef<HTMLInputElement>(null)
  const errorFocus = useRef<HTMLParagraphElement>(null)
  const identity = useRef<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const version = useRef(0)
  const busy = useRef(false)
  const active = useRef(false)

  const refresh = useCallback(async () => {
    if (busy.current || !active.current) return
    const current = ++version.current
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setChecking(true)
    setConfirmed(false)
    setSessionError("")
    try {
      const { user: next } = await getAccountSession(controller.signal)
      if (!active.current || current !== version.current) return
      if (!next || (identity.current && next.id !== identity.current)) {
        busy.current = true
        form.current?.reset()
        setUser(null)
        window.location.replace(next ? "/change-password" : "/login")
        return
      }
      identity.current = next.id
      setUser(next)
      setConfirmed(true)
      setChecking(false)
    } catch (error) {
      if (!active.current || current !== version.current || controller.signal.aborted) return
      setSessionError(accountErrorMessage(error))
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    active.current = true
    void refresh()
    const onFocus = () => { void refresh() }
    const restore = (event: PageTransitionEvent) => { if (event.persisted) void refresh() }
    const clear = () => {
      ++version.current
      request.current?.abort()
      busy.current = false
      setPending(false)
      if (form.current) { form.current.hidden = true; form.current.inert = true }
      setConfirmed(false)
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

  useEffect(() => { if (error && !pending) errorFocus.current?.focus() }, [error, pending])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy.current || !confirmed) return
    const data = new FormData(event.currentTarget)
    const nextPassword = String(data.get("newPassword") || "")
    if (nextPassword !== data.get("confirmPassword")) {
      setError("两次输入的新密码不一致。")
      confirmPassword.current?.focus()
      return
    }
    const current = ++version.current
    request.current?.abort()
    busy.current = true
    setPending(true)
    setError("")
    try {
      await changeAccountPassword(String(data.get("currentPassword") || ""), nextPassword)
      if (!active.current || current !== version.current) return
      form.current?.reset()
      setUser(null)
      setConfirmed(false)
      setChecking(true)
      window.location.replace("/login?password=changed")
    } catch (error) {
      if (!active.current || current !== version.current) return
      setError(accountErrorMessage(error))
    } finally {
      if (active.current && current === version.current) {
        busy.current = false
        setPending(false)
      }
    }
  }

  async function logout() {
    if (busy.current) return
    const current = ++version.current
    request.current?.abort()
    busy.current = true
    setPending(true)
    setConfirmed(false)
    setChecking(true)
    setError("")
    try {
      await signOutAccount()
      if (!active.current || current !== version.current) return
      form.current?.reset()
      setUser(null)
      window.location.replace("/login")
    } catch (error) {
      if (!active.current || current !== version.current) return
      setError(`退出未能确认，会话可能仍然有效。${accountErrorMessage(error)}`)
      busy.current = false
      setPending(false)
      await refresh()
    } finally {
      if (active.current && current === version.current) {
        busy.current = false
        setPending(false)
      }
    }
  }

  return <AccountShell title={user?.mustChangePassword ? "首次登录，请设置密码" : "修改密码"} description="新密码须为 12–128 个字符。保存后会撤销旧会话，请使用新密码重新登录。">
    {checking && <AccountLoading />}
    {!checking && !confirmed && <div className="space-y-4"><p role="alert" aria-live="assertive" className="text-sm text-red-400">{sessionError}</p><Button onClick={() => void refresh()}>重新检查登录状态</Button></div>}
    {user && <form ref={form} hidden={!confirmed} inert={!confirmed} onSubmit={submit} className="space-y-5" aria-busy={pending}>
      <p className="text-sm text-muted-foreground">当前账号：{user.username}</p>
      <input name="username" value={user.username} readOnly autoComplete="username" className="sr-only" tabIndex={-1} aria-label="当前用户名" />
      <div className="space-y-2"><Label htmlFor="current-password">{user.mustChangePassword ? "临时密码" : "当前密码"}</Label><Input ref={currentPassword} id="current-password" name="currentPassword" type="password" autoComplete="current-password" required autoFocus disabled={pending} /></div>
      <div className="space-y-2"><Label htmlFor="new-password">新密码</Label><Input id="new-password" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={pending} aria-describedby="password-hint" /><p id="password-hint" className="text-xs text-muted-foreground">使用 12–128 个字符，请勿继续使用临时密码。</p></div>
      <div className="space-y-2"><Label htmlFor="confirm-password">确认新密码</Label><Input ref={confirmPassword} id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={pending} aria-describedby={error ? "password-error" : undefined} /></div>
      <p ref={errorFocus} tabIndex={-1} id="password-error" role="alert" aria-live="assertive" className="text-sm leading-6 text-red-400">{error}</p>
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "正在处理…" : "保存新密码并重新登录"}</Button>
      <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={() => void logout()}>退出登录</Button>
      {user.mustChangePassword && <p className="text-xs leading-5 text-muted-foreground">如在改密前退出，已使用的临时密码不能再次登录，需要管理员重置。</p>}
    </form>}
  </AccountShell>
}
