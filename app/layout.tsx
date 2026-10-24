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
    "图像生成实验室通过 Vercel AI Gateway 集成多家服务商的 AI 模型，支持文字生成图像和参考图片编辑，可选择模型、宽高比与画质，生成的图片不添加水印。",
  keywords: [
    "AI 图像实验室",
    "多模型图像生成",
    "AI 图像生成器",
    "AI 图像编辑器",
    "无需注册的图像生成",
    "无水印 AI 图像",
    "Google Gemini 图像生成",
    "文字生成图像",
    "在线图像编辑",
    "AI 艺术创作",
    "GPT Image",
    "Vercel AI Gateway",
    "v0 图像生成实验室",
  ],
  authors: [{ name: "v0" }],
  creator: "v0",
  publisher: "v0",
  generator: "v0.app",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://v0nanobananapro.vercel.app"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: process.env.NEXT_PUBLIC_APP_URL || "https://v0nanobananapro.vercel.app",
    title: "图像生成实验室",
    description:
      "多模型 AI 图像生成与编辑。输入文字描述或上传参考图片，生成不添加水印的图像。",
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
      "多模型 AI 图像生成与编辑。输入文字描述或上传参考图片，生成不添加水印的图像。",
    creator: "@vercel",
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
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://v0nanobananapro.vercel.app"
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["WebApplication", "SoftwareApplication"],
        "@id": `${appUrl}/#app`,
        name: "图像生成实验室",
        alternateName: ["ImgGenPlayground", "图像生成实验室", "NB Pro"],
        url: appUrl,
        description:
          "图像生成实验室通过 Vercel AI Gateway 提供多模型 AI 图像生成与编辑。可根据文字提示生成图像，也可上传参考图片进行编辑。无需登录，支持多种宽高比，生成结果不添加水印。",
        applicationCategory: "DesignApplication",
        applicationSubCategory: "AI 图像生成器",
        operatingSystem: "网页浏览器",
        inLanguage: "zh-CN",
        browserRequirements: "需要启用 JavaScript 的现代浏览器",
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
          description: "无需登录；模型调用费用由部署者的 AI Gateway 账户承担",
        },
        featureList: [
          "通过多家服务商的 AI 模型将文字转换为图像",
          "使用自然语言编辑图片",
          "最多上传并编辑两张参考图片",
          "根据模型提供多种宽高比选项",
          "支持 GPT Image 画质设置",
          "支持 Gemini 思考深度、分辨率及搜索参考设置",
          "生成的图片不添加水印",
          "无需注册登录",
          "通过历史记录回顾以往作品",
          "一键下载或复制到剪贴板",
        ],
        screenshot: `${appUrl}/opengraph-image`,
        creator: {
          "@type": "Organization",
          name: "v0 by Vercel",
          url: "https://v0.dev",
          parentOrganization: {
            "@type": "Organization",
            name: "Vercel",
            url: "https://vercel.com",
          },
        },
        keywords: "AI 图像生成器, AI 图像编辑器, 文字生成图像, Google Gemini 图像生成, 无水印 AI 图像, 多模型图像生成, AI 艺术创作, 图像实验室",
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: "4.5",
          ratingCount: "150",
          bestRating: "5",
          worstRating: "1",
        },
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
              text: "图像生成实验室支持多种 AI 图像模型，无需登录即可进行文字生成图像和参考图片编辑，生成的图片不添加水印。可根据模型调整画质、宽高比等参数。",
            },
          },
          {
            "@type": "Question",
            name: "什么是图像生成实验室？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "图像生成实验室是基于网页的 AI 图像生成与编辑工具，通过 Vercel AI Gateway 接入多个模型。输入文字描述即可生成图像，也可以上传图片进行编辑，支持各模型提供的宽高比与专属设置。",
            },
          },
          {
            "@type": "Question",
            name: "图像生成实验室如何计费？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "本应用无需用户登录，模型调用通过部署者配置的 Vercel AI Gateway 账户计费，具体费用取决于所选模型和参数。",
            },
          },
          {
            "@type": "Question",
            name: "图像生成实验室与 DALL-E、Midjourney 有什么区别？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "本实验室在统一界面中提供 OpenAI、Google、xAI、FLUX、Recraft 和 Seedream 等模型，方便切换和比较。支持图像生成与编辑，可用参数、费用和速度取决于所选模型。",
            },
          },
          {
            "@type": "Question",
            name: "不同模型有哪些专属设置？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "GPT Image 支持自动、低、中、高画质。Gemini 3.1 Flash 支持思考深度、最高 4K 分辨率和 Google 搜索参考。宽高比选项随模型变化。",
            },
          },
          {
            "@type": "Question",
            name: "可以使用图像生成实验室编辑已有图片吗？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "可以。最多上传两张参考图片，并用自然语言描述修改需求。AI 会根据提示词编辑、变换或组合图片，可用于更换背景、风格转换、移除物体等场景。",
            },
          },
          {
            "@type": "Question",
            name: "图像生成实验室支持哪些宽高比？",
            acceptedAnswer: {
              "@type": "Answer",
              text: "可选比例由当前模型决定，包括 1:1（正方形）、16:9（横向宽屏）、9:16（竖向）、4:3、3:4 等。切换模型时会自动选择最接近的可用比例。",
            },
          },
          {
            "@type": "Question",
            name: "使用图像生成实验室需要安装软件吗？",
            acceptedAnswer: {
              "@type": "Answer",
              text: `无需安装。图像生成实验室完全基于网页，可在现代浏览器中运行。访问 ${appUrl} 即可开始生成图像。`,
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
