import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"

export function AccountShell({ title, description, children }: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-12 text-foreground">
      <section className="w-full max-w-md space-y-7 border border-border bg-card p-6 sm:p-8" aria-labelledby="account-title">
        <header className="space-y-3">
          <p className="text-xs tracking-widest text-muted-foreground">图像生成实验室</p>
          <h1 id="account-title" className="text-2xl font-semibold">{title}</h1>
          {description && <p className="text-sm leading-6 text-muted-foreground">{description}</p>}
        </header>
        {children}
      </section>
    </main>
  )
}

export function AccountLoading({ message = "正在检查登录状态…" }: { message?: string }) {
  return <div className="flex min-h-40 items-center justify-center gap-2 p-6 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{message}</div>
}
