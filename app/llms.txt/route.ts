export function GET() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://v0nanobananapro.vercel.app"
  const content = `# 图像生成实验室

> 图像生成实验室是通过 Vercel AI Gateway 驱动的多模型 AI 图像生成与编辑工具，可根据文字提示生成图像，也可编辑已有图片。无需登录，生成结果不添加水印。访问地址：${appUrl}

## 关于应用

本应用基于 Next.js 构建并部署于 Vercel，通过统一的模型选择器访问 OpenAI、Google、xAI、Black Forest Labs（FLUX）、Recraft 和字节跳动的图像模型，适合需要使用自然语言快速生成或编辑图像的用户。

基本信息：
- 无需用户登录，也无需数据库
- 生成图片不添加水印
- 支持文字生成图像和 AI 图像编辑
- 图片存储在 Vercel Blob，历史记录保存在当前浏览器中
- 模型调用费用由部署者配置的 AI Gateway 账户承担

## 功能特色

- **文字生成图像**：使用自然语言描述画面，获得 AI 生成结果
- **AI 图像编辑**：最多上传两张参考图片，并描述修改需求
- **多模型选择**：GPT Image、Gemini、Grok、FLUX.2、Recraft、Seedream
- **多种宽高比**：仅显示当前模型支持的比例；切换模型时自动选择最接近的可用比例
- **专属设置**：GPT Image 支持画质设置；Gemini 3.1 Flash 支持思考深度、最高 4K 分辨率和 Google 搜索参考
- **生成历史**：浏览并回顾当前浏览器中的生成记录
- **下载与复制**：保存图片，或直接复制到剪贴板

## 模型比较

不同模型的画质、速度、费用、宽高比及编辑能力有所不同。可通过模型选择器切换并比较，不承诺固定生成时长；具体能力与费用以服务商和 AI Gateway 的当前说明为准。

## 使用场景

- 社交媒体内容创作
- 博客与文章配图
- 概念设计与创意探索
- 产品效果图与可视化
- 教学材料与演示文稿
- 设计项目的快速原型制作

## 使用方法

1. 访问 ${appUrl}
2. 在提示词输入框中描述想要生成的图像
3. 按需上传一到两张参考图片，用于编辑或风格参考
4. 选择模型及可用的宽高比
5. 按需调整画质、思考深度、分辨率等设置
6. 点击“生成图像”
7. 下载、复制结果，或将结果用作参考图片继续编辑

## 技术栈

- **图像模型**：OpenAI、Google Gemini、xAI、FLUX、Recraft、Seedream
- **AI 基础设施**：Vercel AI Gateway 与 AI SDK
- **框架**：Next.js 16（App Router）
- **托管**：Vercel
- **持久化任务**：Vercel Workflow
- **图片存储**：Vercel Blob
- **历史记录**：当前浏览器的 localStorage
- **界面语言**：简体中文，内置思源黑体

## 常见问题

**需要登录吗？**
不需要。当前版本不包含用户登录或积分系统。

**如何计费？**
所有模型请求通过部署者的 AI Gateway 账户计费，具体费用取决于模型和参数。

**生成的图片有水印吗？**
本应用不向生成结果添加水印。

**使用哪些 AI 模型？**
通过 Vercel AI Gateway 接入 GPT Image、Gemini、Grok、FLUX.2、Recraft 和 Seedream 系列模型，具体以界面中的模型列表为准。

**能编辑已有图片吗？**
可以。最多上传两张图片，并在提示词中描述希望进行的修改。

**支持哪些宽高比？**
选项由当前模型决定，包含 1:1（正方形）、16:9（横向）、9:16（竖向）、4:3、3:4 等。

**需要安装软件吗？**
不需要。应用完全基于网页，可在现代浏览器中运行。

**图像生成需要多久？**
耗时取决于所选模型、参数、请求内容及服务负载。生成过程中会显示进度，耗时较长时会提示等待。

## 相关链接

- [图像生成实验室](${appUrl})：在线应用
- [Vercel AI Gateway](https://vercel.com/docs/ai/ai-gateway)：图像生成使用的 AI 基础设施
- [v0 by Vercel](https://v0.dev)：构建本应用的 AI 开发平台
`

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
    },
  })
}
