import type { Metadata } from "next"
import { LoginForm } from "@/components/account/login-form"

export const metadata: Metadata = { title: "登录 · 图像生成实验室", robots: { index: false, follow: false } }

export default function LoginPage() {
  return <LoginForm />
}
