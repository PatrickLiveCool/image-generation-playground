import { Suspense } from "react"
import type { Metadata } from "next"
import { GuardedAdminPage } from "@/components/account/admin-page"
import { AccountLoading } from "@/components/account/account-shell"

export const metadata: Metadata = { title: "账号管理 · 图像生成实验室", robots: { index: false, follow: false } }

export default function AdminUsersPage() {
  return <Suspense fallback={<AccountLoading message="正在核对管理权限…" />}><GuardedAdminPage /></Suspense>
}
