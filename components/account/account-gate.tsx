"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { LogOut, Shield, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AccountLoading, AccountShell } from "@/components/account/account-shell"
import { AccountVisibilityContext } from "@/components/account/account-visibility"
import { ACCOUNT_SESSION_CHANNEL, ACCOUNT_SESSION_RECHECK_EVENT, accountErrorMessage, getAccountSession, signOutAccount } from "@/lib/account-client"
import type { AccountUser } from "@/lib/account-types"

type GateState = { kind: "checking" | "leaving" | "ready" } | { kind: "error"; message: string }

export function AccountGate({ children, admin = false }: {
  children: (user: Readonly<AccountUser>) => ReactNode
  admin?: boolean
}) {
  const [state, setState] = useState<GateState>({ kind: "checking" })
  const [user, setUser] = useState<AccountUser | null>(null)
  const [logoutError, setLogoutError] = useState("")
  const request = useRef<AbortController | null>(null)
  const version = useRef(0)
  const content = useRef<HTMLDivElement>(null)
  const identity = useRef<string | null>(null)
  const leaving = useRef(false)
  const active = useRef(false)

  const refresh = useCallback(async () => {
    if (leaving.current || !active.current) return
    const current = ++version.current
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setState({ kind: "checking" })
    try {
      const { user: next } = await getAccountSession(controller.signal)
      if (current !== version.current || !active.current) return
      if (!next || next.mustChangePassword || (identity.current && identity.current !== next.id)) {
        leaving.current = true
        setUser(null)
        setState({ kind: "leaving" })
        window.location.replace(!next ? "/login" : next.mustChangePassword ? "/change-password" : "/")
        return
      }
      if (admin && next.role !== "admin") {
        setUser(null)
        setState({ kind: "error", message: "当前账号无权访问管理后台。" })
      } else {
        identity.current = next.id
        setUser(next)
        setState({ kind: "ready" })
      }
    } catch (error) {
      if (current !== version.current || controller.signal.aborted || !active.current) return
      setState({ kind: "error", message: accountErrorMessage(error) })
    }
  }, [admin])

  useEffect(() => {
    active.current = true
    void refresh()
    const onFocus = () => { void refresh() }
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh() }
    const onPageHide = () => {
      ++version.current
      request.current?.abort()
      // Hide synchronously before the browser saves its back/forward snapshot.
      if (content.current) { content.current.hidden = true; content.current.inert = true }
      setState({ kind: "checking" })
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) { leaving.current = false; void refresh() }
    }
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(ACCOUNT_SESSION_CHANNEL)
    if (channel) channel.onmessage = onFocus
    window.addEventListener("focus", onFocus)
    window.addEventListener(ACCOUNT_SESSION_RECHECK_EVENT, onFocus)
    window.addEventListener("pageshow", onPageShow)
    window.addEventListener("pagehide", onPageHide)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      active.current = false
      ++version.current
      request.current?.abort()
      channel?.close()
      window.removeEventListener("focus", onFocus)
      window.removeEventListener(ACCOUNT_SESSION_RECHECK_EVENT, onFocus)
      window.removeEventListener("pageshow", onPageShow)
      window.removeEventListener("pagehide", onPageHide)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [refresh])

  async function logout() {
    if (leaving.current) return
    leaving.current = true
    const current = ++version.current
    request.current?.abort()
    setState({ kind: "leaving" })
    setLogoutError("")
    try {
      await signOutAccount()
      if (current !== version.current || !active.current) return
      setUser(null)
      window.location.replace("/login")
    } catch (error) {
      if (current !== version.current || !active.current) return
      leaving.current = false
      setLogoutError(`退出未能确认，会话可能仍然有效。${accountErrorMessage(error)}`)
      // A lost write response may still have revoked the cookie. Restore the
      // same mounted page only after confirming that its identity remains valid.
      await refresh()
    }
  }

  const visible = state.kind === "ready"
  return <div>
    <div ref={content} hidden={!visible} inert={!visible} aria-hidden={!visible} data-account-content="">
      <AccountVisibilityContext.Provider value={visible}>
        {user && <div key={user.id} className="flex h-dvh flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-background px-4 py-2 text-sm">
            <p className="min-w-0 truncate text-muted-foreground"><span className="text-foreground">{user.name}</span><span className="ml-2">@{user.username}</span></p>
            <nav className="flex items-center gap-2" aria-label="账号操作">
              {user.role === "admin" && <Button asChild variant="ghost" size="sm"><a href="/admin/users"><Shield className="size-4" aria-hidden="true" />管理后台</a></Button>}
              {user.role === "admin" && <Button asChild variant="ghost" size="sm"><a href="/admin/models"><Settings2 className="size-4" aria-hidden="true" />模型设置</a></Button>}
              <Button type="button" size="sm" variant="ghost" onClick={() => void logout()}><LogOut className="size-4" aria-hidden="true" />退出</Button>
            </nav>
          </div>
          {logoutError && <p role="alert" aria-live="assertive" className="border-b border-border px-4 py-3 text-sm text-red-400">{logoutError}</p>}
          {children(user)}
        </div>}
      </AccountVisibilityContext.Provider>
    </div>
    {!visible && (state.kind === "error" ? <AccountShell title="暂时无法进入" description={state.message}>
      <div className="flex flex-wrap gap-3"><Button onClick={() => void refresh()}>重新检查登录状态</Button><Button asChild variant="outline"><a href="/">返回创作</a></Button><Button onClick={() => void logout()} variant="ghost">退出登录</Button></div>
      {logoutError && <p role="alert" aria-live="assertive" className="text-sm text-red-400">{logoutError}</p>}
    </AccountShell> : <AccountLoading message={state.kind === "leaving" ? "正在处理登录状态…" : undefined} />)}
  </div>
}
