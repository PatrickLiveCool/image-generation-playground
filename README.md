# 图像生成实验室

由 [Vercel AI Gateway](https://vercel.com/ai-gateway) 驱动的多模型 AI 图像生成实验室。使用 OpenAI、Google、xAI、Black Forest Labs（FLUX）、Recraft 和字节跳动的模型生成与编辑图片，通过同一个 API 密钥访问。无需登录，也无需数据库。

## 功能特色

- **统一的多模型选择器**：GPT Image、Gemini、Grok、FLUX.2、Recraft、Seedream。
- **按模型提供宽高比**：仅显示各模型支持的比例，切换模型时自动选择最接近的可用比例。
- **GPT 画质控制**，以及 Gemini 思考深度、分辨率和搜索参考设置。
- **文字生成图像与图像编辑**：支持拖放图片或粘贴图片链接。
- 生成的图片存储在 **Vercel Blob**，历史记录保存在当前浏览器中（localStorage）。
- 简体中文界面，使用项目内置的思源黑体资源显示中文。

## 本地开发配置

推荐通过 GitHub 克隆项目后安装依赖；以下命令用于本地开发环境，v0 预览中无需手动运行。

1. **克隆并安装**

   ```bash
   git clone https://github.com/vercel-labs/v0-nanobanana-template.git
   cd v0-nanobanana-template
   pnpm install
   ```

2. **配置环境变量**

   将 `.env.example` 复制为 `.env.local`，填写配置：

   ```bash
   cp .env.example .env.local
   ```

   | 变量 | 是否必需 | 说明 |
   |------|----------|------|
   | `AI_GATEWAY_API_KEY` | 是 | 当前实现使用的 [Vercel AI Gateway](https://vercel.com/ai-gateway) API 密钥，每次生成均计入该账户费用 |
   | `BLOB_READ_WRITE_TOKEN` | 是 | 用于存储生成图片的 Vercel Blob 读写令牌 |

3. **启动本地开发服务**

   ```bash
   pnpm dev
   ```

## 工作原理

每次生成均作为持久化的 [Vercel Workflow](https://vercel.com/docs/workflow) 任务运行。Gemini 模型通过 AI SDK 的 `generateText` 生成图片（启用图像响应类型），其他服务商通过 `generateImage` 生成。每个请求使用**部署者的** AI Gateway 密钥，因此模型选择和费用由部署者管理，不包含按用户区分的登录或积分系统。

## 部署

[![部署到 Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/vercel-labs/v0-nanobanana-template)

在 Vercel 项目设置中配置 `AI_GATEWAY_API_KEY`，并连接 **Blob** 存储（会提供 `BLOB_READ_WRITE_TOKEN`）。
