import { ImageCombiner } from "@/components/image-combiner"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "图像生成实验室",
  description:
    "配置自己的中转 API，在设置中将自定义名称映射到实际模型，再选择名称生成图像或编辑参考图片。支持 Images 与 Chat Completions 兼容生图接口。",
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
            或使用人工智能编辑已有图片。通过 API 设置填写自己的中转地址与 Token，并设置显示名称与实际模型的映射。
          </p>
        </section>
        <section>
          <h2>功能特色</h2>
          <ul>
            <li>文字生成图像：描述想要的画面，即可获得 AI 生成的图像</li>
            <li>持续修改：当前展示的版本自动作为下一轮基准图，选择旧版本也能继续修改</li>
            <li>创作管理：新建、切换和重命名，每项创作独立保存草稿、参考图和版本历史</li>
            <li>自定义 API：随时更换 Base URL、Token 和生图接口类型</li>
            <li>模型映射：在设置中读取模型列表或填写 ID，自定义显示名称；生成界面只展示这些名称</li>
            <li>图片参数：按接口选择宽高比与画质，实际能力取决于中转和模型</li>
            <li>无需注册或登录</li>
          </ul>
        </section>
        <section>
          <h2>使用方法</h2>
          <p>
            先在“API 设置”中配置中转地址和 Token，将自定义名称映射到支持生图的模型。保存后选择名称、输入提示词，也可以上传最多两张参考图片，
            点击“生成图片”并保持页面打开。生成后直接输入修改要求并点击“修改 V1”，后续版本同理；修改时可添加一张补充参考图。历史版本可随时查看、下载、复制或选为下一轮修改的基准。
          </p>
        </section>
        <section>
          <h2>技术支持</h2>
          <p>
            图像生成实验室支持 Images 与 Chat Completions 兼容生图接口。API 配置保存在当前浏览器，
            历史记录保存在当前浏览器。参考图、生成结果和任务记录存放在私有对象存储，应用服务器不保存图片文件。
          </p>
        </section>
      </article>
    </main>
  )
}
