import type { Metadata } from "next"
import { AccountWorkspace } from "@/components/account-workspace"

export const metadata: Metadata = {
  title: "我的创作 · 图像生成实验室",
  description: "登录账号，使用文字、参考图片和文档持续创作。",
  robots: { index: false, follow: false },
}

export default function Home() {
  return <main className="min-h-screen bg-background"><AccountWorkspace /></main>
}
