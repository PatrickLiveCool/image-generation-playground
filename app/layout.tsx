import type React from "react"
import type { Metadata } from "next"
import localFont from "next/font/local"
import { Suspense } from "react"
import { Analytics } from "@vercel/analytics/react"
import { ErrorBoundary } from "@/components/error-boundary"
import "./globals.css"

const chineseFont = localFont({
  src: "./fonts/SourceHanSansSC-Regular.otf",
  variable: "--font-chinese",
  display: "swap",
  weight: "400",
})

const geistPixel = localFont({
  src: "./fonts/GeistPixelBETA-Square.otf",
  variable: "--font-geist-pixel",
  display: "swap",
})

export const metadata: Metadata = {
  title: "图像生成实验室",
  description: "使用账号登录，选择配置好的模型，通过文字、参考图与文档持续创作。",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
}

export const viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${chineseFont.variable} ${geistPixel.variable}`}
      suppressHydrationWarning
      style={{ backgroundColor: "#000000" }}
    >
      <body className="font-mono antialiased" style={{ backgroundColor: "#000000" }}>
        <ErrorBoundary>
          <Suspense fallback={null}>{children}</Suspense>
        </ErrorBoundary>
        <Analytics />
      </body>
    </html>
  )
}
