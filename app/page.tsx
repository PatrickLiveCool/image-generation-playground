import { ImageCombiner } from "@/components/image-combiner"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "图像生成实验室",
  description:
    "使用多个 AI 模型将文字转换为图像，或编辑已有图片。通过 Vercel AI Gateway 选择模型、宽高比与画质，无需登录，生成结果不添加水印。",
}

export default function Home() {
  return (
    <main className="min-h-screen bg-background">
      <ImageCombiner />
      <article className="sr-only" aria-hidden="true">
        <h1>图像生成实验室 — AI 图像生成器</h1>
        <section>
          <h2>什么是图像生成实验室？</h2>
          <p>
            图像生成实验室是基于网页的 AI 图像生成与编辑工具，可根据文字描述生成图像，
            或使用人工智能编辑已有图片。应用通过 Vercel AI Gateway 接入多个模型，并部署于 Vercel。
          </p>
        </section>
        <section>
          <h2>功能特色</h2>
          <ul>
            <li>文字生成图像：描述想要的画面，即可获得 AI 生成的图像</li>
            <li>图像编辑：上传图片，并描述希望进行的修改</li>
            <li>多种宽高比：按模型提供 1:1（正方形）、16:9（横向）、9:16（竖向）等选项</li>
            <li>模型专属设置：调整画质、思考深度、分辨率与搜索参考</li>
            <li>生成的图片不添加水印</li>
            <li>无需注册或登录</li>
          </ul>
        </section>
        <section>
          <h2>使用方法</h2>
          <p>
            输入提示词，描述想要的图片，也可以上传参考图片。选择模型、宽高比与相关设置，
            点击“生成图像”。生成后可下载、复制或继续编辑。
          </p>
        </section>
        <section>
          <h2>技术支持</h2>
          <p>
            图像生成实验室通过 Vercel AI Gateway 访问 OpenAI、Google、xAI、FLUX、Recraft 和 Seedream 等模型，
            使用 Vercel Workflow 执行生成任务，并通过 Vercel Blob 保存图片。
          </p>
        </section>
      </article>
    </main>
  )
}
