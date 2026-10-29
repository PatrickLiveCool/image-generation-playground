import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { AccountError, requireAccount } from "@/lib/auth/guards"
import { AdminModels } from "@/components/account/admin-models"
import { AccountShell } from "@/components/account/account-shell"
import { Button } from "@/components/ui/button"

export async function GuardedAdminModelsPage() {
  try {
    await requireAccount(await headers(), { admin: true })
  } catch (error) {
    if (error instanceof AccountError && error.status === 401) redirect("/login")
    if (error instanceof AccountError && error.code === "PASSWORD_CHANGE_REQUIRED") redirect("/change-password")
    const forbidden = error instanceof AccountError && error.status === 403
    return <AccountShell title={forbidden ? "没有管理权限" : "管理后台暂不可用"} description={forbidden ? "当前账号无权访问管理后台。" : "暂时无法核对管理权限，请稍后重试。"}>
      <div className="flex gap-3"><Button asChild variant="outline"><a href="/">返回创作</a></Button>{!forbidden && <Button asChild><a href="/admin/models">重试</a></Button>}</div>
    </AccountShell>
  }
  return <AdminModels />
}
