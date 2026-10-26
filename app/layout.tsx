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
  description:
    "图像生成实验室支持自定义中转 API，在设置中将自定义名称映射到实际模型，通过 Images 或 Chat Completions 兼容接口生成和编辑图片。",
  keywords: [
    "AI 图像实验室",
    "多模型图像生成",
    "AI 图像生成器",
    "AI 图像编辑器",
    "无需注册的图像生成",
    "自定义 API 生图",
    "中转 API 配置",
    "文字生成图像",
    "在线图像编辑",
    "AI 艺术创作",
    "Images API",
    "Chat Completions 生图",
  ],
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    title: "图像生成实验室",
    description:
      "连接自己的中转 API，选择支持生图的模型，使用文字描述或参考图片生成新图像。",
    siteName: "图像生成实验室",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "图像生成实验室 — AI 图像生成界面",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "图像生成实验室",
    description:
      "连接自己的中转 API，选择支持生图的模型，使用文字描述或参考图片生成新图像。",
    images: ["/opengraph-image"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  manifest: "/manifest.webmanifest",
}

export const viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
}

function JsonLd() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["WebApplication", "SoftwareApplication"],
        "@id": `${appUrl}/#app`,
        name: "图像生成实验室",
        alternateName: ["ImgGenPlayground", "图像生成实验室"],
        url: appUrl,
        description:
          "图像生成实验室通过用户配置的中转 API 生成和编辑图片。在 API 设置中读取模型列表或填写 ID，并建立自定义名称与实际模型的映射；生成界面只显示自定义名称。兼容 Images 与 Chat Completions 生图接口。",
        applicationCategory: "DesignApplication",
        applicationSubCategory: "AI 图像生成器",
        operatingSystem: "网页浏览器",
        inLanguage: "zh-CN",
        browserRequirements: "需要启用 JavaScript 的现代浏览器",
        featureList: [
          "通过自定义中转 API 将文字转换为图像",
          "在页面中配置 Base URL、Token 和生图接口类型",
          "在设置中读取模型列表或填写 ID，自由维护显示名称与实际模型的映射",
          "使用自然语言编辑图片",
          "最多上传并编辑两张参考图片",
          "按接口选择宽高比与画质参数",
          "无需注册登录",
          "通过历史记录回顾以往作品",
          "一键下载或复制到剪贴板",
        ],
        screenshot: `${appUrl}/opengraph-image`,
        keywords: "AI 图像生成器, AI 图像编辑器, 文字生成图像, 自定义 API, 中转 API 配置, 多模型图像生成, 图像实验室",
      },
      {
        "@type": "FAQPage",
        "@id": `${appUrl}/#faq`,
        mainEntity: [
          {
            "@type": "Question",
            name: "图像生成实验室可以做什么？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "配置自己的中转 API 后，可使用兼容的模型进行文字生成图像和参考图片编辑。模型列表、图片能力和可用参数取决于中转及所选模型。",
            },
          },
          {
            "@type": "Question",
            name: "什么是图像生成实验室？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "图像生成实验室是基于网页的 AI 图像生成与编辑工具，可在 API 设置中更换 Base URL 和 Token、读取模型列表或填写 ID，再将自定义名称映射到实际模型。生成界面只显示自定义名称，支持 Images 与 Chat Completions 兼容生图接口。",
            },
          },
          {
            "@type": "Question",
            name: "图像生成实验室如何计费？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "模型调用使用 API 设置中填写的 Token，费用由对应中转账户承担，具体计费以中转服务为准。取消本页等待不保证上游任务停止或免除费用。",
            },
          },
          {
            "@type": "Question",
            name: "图像生成实验室可以接入哪些模型？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "模型由所配置的中转服务提供，可在 API 设置中读取列表或填写 ID，并为模型设置自定义显示名称。请选用支持生图且兼容 Images 或 Chat Completions 接口的模型；模型列表中也可能包含仅支持文字的模型。",
            },
          },
          {
            "@type": "Question",
            name: "可以调整哪些图片参数？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Images 接口提供固定尺寸与自动、低、中、高画质选项，需中转和模型支持。Chat Completions 接口将期望宽高比写入提示词，实际输出由中转和模型决定。",
            },
          },
          {
            "@type": "Question",
            name: "可以使用图像生成实验室编辑已有图片吗？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "所选中转和模型支持图片编辑时，可以上传最多两张参考图片，并用自然语言描述修改需求。提交的单张图片不超过 10 MB，实际效果取决于模型。",
            },
          },
          {
            "@type": "Question",
            name: "图像生成实验室支持哪些宽高比？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "比例选项按所选模型的能力展示。Images 接口将比例转换为尺寸参数，Chat Completions 接口可在提示词中表达期望比例，实际尺寸以中转和模型返回结果为准。",
            },
          },
          {
            "@type": "Question",
            name: "使用图像生成实验室需要安装软件吗？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "已启动或部署的应用可在现代浏览器中使用，无需安装客户端。首次生成前需在 API 设置中填写中转地址与 Token；生成期间请保持页面打开。",
            },
          },
        ],
      },
    ],
  }

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Note: Token refresh is handled by individual Route Handlers
  // Cannot refresh here because Server Components cannot modify cookies
  return (
    <html
      lang="zh-CN"
      className={`${chineseFont.variable} ${geistPixel.variable}`}
      suppressHydrationWarning
      style={{ backgroundColor: "#000000" }}
    >
      <head>
        {/* DNS prefetch for Vercel API (OAuth, token refresh) */}
        <link rel="dns-prefetch" href="https://api.vercel.com" />
        <JsonLd />
      </head>
      <body className="font-mono antialiased" style={{ backgroundColor: "#000000" }}>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('nb_authed')==='1')document.documentElement.classList.add('nb-authed')}catch(e){}`,
          }}
        />
        <ErrorBoundary>
          <Suspense fallback={null}>{children}</Suspense>
        </ErrorBoundary>
        <Analytics />
      </body>
    </html>
  )
}
