import type { Metadata } from "next"
import { ChangePasswordForm } from "@/components/account/change-password-form"

export const metadata: Metadata = { title: "修改密码 · 图像生成实验室", robots: { index: false, follow: false } }

export default function ChangePasswordPage() {
  return <ChangePasswordForm />
}
