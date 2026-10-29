"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Copy, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AccountGate } from "@/components/account/account-gate"
import { AccountLoading } from "@/components/account/account-shell"
import { AccountRequestError, accountErrorMessage, createAccount, listAccounts, updateAccount } from "@/lib/account-client"
import type { AccountAction, AccountUser, AccountUsersPage, AdminAccountUser, TemporaryPassword } from "@/lib/account-types"

type PasswordResult = TemporaryPassword & { username: string }
type PendingAction = { user: AdminAccountUser; action: AccountAction }

function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "时间未知"
}

function accountStatus(user: AdminAccountUser) {
  return user.banned ? "已禁用" : user.mustChangePassword ? "待首次改密" : "可用"
}

function handleSessionError(error: unknown) {
  if (!(error instanceof AccountRequestError)) return false
  if (error.status === 401) { window.location.replace("/login"); return true }
  if (error.code === "PASSWORD_CHANGE_REQUIRED") { window.location.replace("/change-password"); return true }
  if (error.status === 403) { window.location.replace("/admin/users"); return true }
  return false
}

function TemporaryPasswordDialog({ result, close }: { result: PasswordResult; close: () => void }) {
  const [copyStatus, setCopyStatus] = useState("")
  const input = useRef<HTMLInputElement>(null)
  async function copy() {
    try {
      await navigator.clipboard.writeText(result.temporaryPassword)
      setCopyStatus("临时密码已复制。")
    } catch {
      input.current?.focus()
      input.current?.select()
      setCopyStatus("无法自动复制，已选中密码，请手动复制。")
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) close() }}>
    <DialogContent onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); input.current?.select() }}>
      <DialogHeader><DialogTitle>请保存本次临时密码</DialogTitle><DialogDescription>账号 {result.username} 的临时密码仅在本次响应中显示，关闭后无法再次查看。</DialogDescription></DialogHeader>
      <div className="space-y-2"><Label htmlFor="temporary-password">临时密码</Label><div className="flex gap-2"><Input ref={input} id="temporary-password" value={result.temporaryPassword} readOnly autoComplete="off" spellCheck={false} className="font-mono" /><Button type="button" variant="outline" onClick={() => void copy()}><Copy aria-hidden="true" className="size-4" />复制</Button></div></div>
      <p className="text-sm leading-6 text-muted-foreground">请在 24 小时内首次登录并修改密码。此密码只可使用一次；过期、遗失或登录后未改密便退出，均需管理员明确重置。</p>
      <p className="text-sm">到期时间：{dateLabel(result.expiresAt)}</p>
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{copyStatus}</p>
      <DialogFooter><Button onClick={close}>已保存，关闭</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

function AdminUsersManager({ currentUser }: { currentUser: AccountUser }) {
  const [page, setPage] = useState<AccountUsersPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [createError, setCreateError] = useState("")
  const [mustCheckCreation, setMustCheckCreation] = useState(false)
  const [pending, setPending] = useState(false)
  const [confirmation, setConfirmation] = useState<PendingAction | null>(null)
  const [passwordResult, setPasswordResult] = useState<PasswordResult | null>(null)
  const controller = useRef<AbortController | null>(null)
  const active = useRef(false)
  const requestId = useRef(0)
  const mutating = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  const errorFocus = useRef<HTMLParagraphElement>(null)
  const createErrorFocus = useRef<HTMLParagraphElement>(null)

  const load = useCallback(async (nextOffset: number) => {
    controller.current?.abort()
    const current = ++requestId.current
    const abort = new AbortController()
    controller.current = abort
    setLoading(true)
    setLoadError("")
    try {
      const result = await listAccounts(nextOffset, abort.signal)
      if (!active.current || current !== requestId.current) return false
      setPage(result)
      setOffset(result.offset)
      return true
    } catch (error) {
      if (!active.current || abort.signal.aborted || current !== requestId.current) return false
      setPage(null)
      if (!handleSessionError(error)) setLoadError(accountErrorMessage(error))
      return false
    } finally {
      if (active.current && current === requestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    active.current = true
    void load(0)
    return () => { active.current = false; ++requestId.current; controller.current?.abort() }
  }, [load])

  useEffect(() => { if (actionError || loadError) errorFocus.current?.focus() }, [actionError, loadError])
  useEffect(() => { if (createError && !pending) createErrorFocus.current?.focus() }, [createError, pending])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutating.current || mustCheckCreation) return
    const form = new FormData(event.currentTarget)
    mutating.current = true
    setPending(true)
    setCreateError("")
    setNotice("")
    setActionError("")
    try {
      const result = await createAccount(String(form.get("username") || ""), String(form.get("name") || ""))
      if (!active.current) return
      setCreateOpen(false)
      setPasswordResult({ username: result.user.username, temporaryPassword: result.temporaryPassword, expiresAt: result.expiresAt })
      setNotice(`账号 ${result.user.username} 已创建。`)
      await load(offset)
    } catch (error) {
      if (!active.current) return
      if (!handleSessionError(error)) {
        setMustCheckCreation(true)
        setCreateError(`${accountErrorMessage(error)} 请先刷新列表核对账号是否已创建；再次创建不会重置已有账号。`)
      }
    } finally {
      mutating.current = false
      if (active.current) setPending(false)
    }
  }

  async function act() {
    if (mutating.current || !confirmation) return
    const operation = confirmation
    mutating.current = true
    setPending(true)
    setActionError("")
    setNotice("")
    try {
      const credential = await updateAccount(operation.user.id, operation.action)
      if (!active.current) return
      setConfirmation(null)
      if (credential) setPasswordResult({ username: operation.user.username, ...credential })
      const message = operation.action === "disable" ? "已禁用，旧会话已撤销" : operation.action === "restore" ? "已恢复，需重新登录，旧会话不会恢复" : "密码已重置，旧会话已撤销"
      setNotice(`${operation.user.username}：${message}。`)
      await load(offset)
    } catch (error) {
      if (!active.current) return
      setConfirmation(null)
      if (!handleSessionError(error)) {
        const message = error instanceof AccountRequestError && error.code === "LAST_ADMIN" ? "不能禁用或重置最后一位可用管理员，请保留管理入口。" : accountErrorMessage(error)
        const unknown = error instanceof AccountRequestError && (error.status === 0 || error.status >= 500)
        const resetHint = operation.action === "reset-password" && unknown ? "若重置结果遗失，须重新明确执行重置，此前临时密码将失效。" : ""
        setActionError(`${message} 请核对刷新后的账号状态。${resetHint}`)
        await load(offset)
      }
    } finally {
      mutating.current = false
      if (active.current) setPending(false)
    }
  }

  const actionTitle = confirmation?.action === "disable" ? "禁用账号" : confirmation?.action === "restore" ? "恢复账号" : "重置密码"

  return <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2"><a href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">返回创作</a><h1 className="text-2xl font-semibold">账号管理</h1><p className="text-sm text-muted-foreground">创建普通用户，管理账号状态和临时密码。</p></div>
      <div className="flex gap-2"><Button variant="outline" disabled={loading || pending} onClick={() => void load(offset)}><RefreshCw className="size-4" aria-hidden="true" />刷新</Button><Button disabled={pending || loading || !!loadError} onClick={() => { setCreateError(""); setCreateOpen(true) }}><Plus className="size-4" aria-hidden="true" />新增账号</Button></div>
    </header>
    {notice && <p role="status" aria-live="polite" className="border border-border p-4 text-sm">{notice}</p>}
    {(actionError || loadError) && <p ref={errorFocus} tabIndex={-1} role="alert" aria-live="assertive" className="border border-red-400/50 p-4 text-sm leading-6 text-red-400">{actionError || loadError}</p>}
    {loading ? <AccountLoading message="正在读取账号列表…" /> : loadError ? <div className="space-y-3 py-8 text-center"><p className="text-sm text-muted-foreground">账号列表暂时无法读取。</p><Button variant="outline" onClick={() => void load(offset)}>重新加载</Button></div> : page && <>
      <div className="border border-border"><Table><TableCaption className="sr-only">账号状态和管理员操作</TableCaption><TableHeader><TableRow><TableHead>账号</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead><TableHead>创建时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>
        {page.users.length === 0 ? <TableRow><TableCell colSpan={5} className="py-12 text-center text-muted-foreground">当前页暂无账号。</TableCell></TableRow> : page.users.map((user) => <TableRow key={user.id}>
          <TableCell><div className="font-medium">{user.name}</div><div className="mt-1 text-xs text-muted-foreground">@{user.username}</div></TableCell>
          <TableCell className="whitespace-nowrap">{user.role === "admin" ? "管理员" : "普通用户"}</TableCell>
          <TableCell className="whitespace-nowrap"><span className="border border-border px-2 py-1 text-xs">{accountStatus(user)}</span></TableCell>
          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{dateLabel(user.createdAt)}</TableCell>
          <TableCell className="text-right">{user.id === currentUser.id ? <span className="text-xs text-muted-foreground">当前账号</span> : <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmation({ user, action: user.banned ? "restore" : "disable" })}>{user.banned ? "恢复" : "禁用"}</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirmation({ user, action: "reset-password" })}>重置密码</Button>
          </div>}</TableCell>
        </TableRow>)}
      </TableBody></Table></div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"><p>共 {page.total} 个账号{page.total > 0 && ` · 当前 ${offset + 1}–${offset + page.users.length}`}</p><nav className="flex gap-2" aria-label="账号列表分页"><Button variant="outline" size="sm" disabled={pending || offset === 0} onClick={() => void load(Math.max(0, offset - page.limit))}>上一页</Button><Button variant="outline" size="sm" disabled={pending || offset + page.limit >= page.total} onClick={() => void load(offset + page.limit)}>下一页</Button></nav></div>
    </>}

    <Dialog open={createOpen} onOpenChange={(open) => { if (!pending) setCreateOpen(open) }}>
      <DialogContent showCloseButton={!pending} onEscapeKeyDown={(event) => { if (pending) event.preventDefault() }} onPointerDownOutside={(event) => { if (pending) event.preventDefault() }}>
        <DialogHeader><DialogTitle>新增普通用户</DialogTitle><DialogDescription>系统生成一次性临时密码，账号创建成功后显示。重复创建不会重置已有账号。</DialogDescription></DialogHeader>
        <form onSubmit={create} className="space-y-5" aria-busy={pending}>
          <div className="space-y-2"><Label htmlFor="create-username">用户名</Label><Input id="create-username" name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9_-]{3,32}" minLength={3} maxLength={32} required autoFocus disabled={pending} aria-describedby="username-hint" /><p id="username-hint" className="text-xs text-muted-foreground">3–32 位英文字母、数字、下划线或短横线，字母不区分大小写。</p></div>
          <div className="space-y-2"><Label htmlFor="create-name">显示名称</Label><Input id="create-name" name="name" autoComplete="off" maxLength={80} required disabled={pending} /></div>
          <p ref={createErrorFocus} tabIndex={-1} role="alert" aria-live="assertive" className="text-sm leading-6 text-red-400">{createError}</p>
          {mustCheckCreation && <Button type="button" variant="outline" disabled={loading || pending} onClick={async () => { if (await load(offset)) { setMustCheckCreation(false); setCreateOpen(false) } }}>刷新列表核对</Button>}
          <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setCreateOpen(false)}>取消</Button><Button type="submit" disabled={pending || mustCheckCreation}>{pending ? "正在创建…" : "创建账号"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog open={!!confirmation} onOpenChange={(open) => { if (!open && !pending) setConfirmation(null) }}>
      <DialogContent showCloseButton={!pending} onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus() }} onEscapeKeyDown={(event) => { if (pending) event.preventDefault() }} onPointerDownOutside={(event) => { if (pending) event.preventDefault() }}>
        <DialogHeader><DialogTitle>{actionTitle}</DialogTitle><DialogDescription>确认对账号 {confirmation?.user.username} 执行「{actionTitle}」？</DialogDescription></DialogHeader>
        <p className="text-sm leading-6 text-muted-foreground">{confirmation?.action === "disable" ? "禁用后立即撤销该账号全部旧会话，用户无法继续登录。恢复账号不会恢复旧会话。" : confirmation?.action === "restore" ? "恢复后用户需要重新登录，禁用前的旧会话不会恢复。若临时密码已使用或过期，还需要另行重置密码。" : "重置会立即撤销该账号全部旧会话和原密码。新临时密码仅在本次响应中显示，须在 24 小时内首次登录后改密。"}</p>
        {confirmation?.action === "reset-password" && confirmation.user.banned && <p className="text-sm text-muted-foreground">该账号仍处于禁用状态，重置密码后还需明确恢复账号。</p>}
        <DialogFooter><Button ref={cancel} variant="outline" disabled={pending} onClick={() => setConfirmation(null)}>取消</Button><Button disabled={pending} onClick={() => void act()}>{pending ? "正在处理…" : `确认${actionTitle}`}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {passwordResult && <TemporaryPasswordDialog result={passwordResult} close={() => setPasswordResult(null)} />}
  </main>
}

export function AdminUsers() {
  return <AccountGate admin>{(user) => <AdminUsersManager currentUser={user} key={user.id} />}</AccountGate>
}
