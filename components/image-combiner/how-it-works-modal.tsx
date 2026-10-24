"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface HowItWorksModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function HowItWorksModal({ open, onOpenChange }: HowItWorksModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-black/95 border border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold">使用说明</DialogTitle>
        </DialogHeader>
        <div className="space-y-6 text-sm text-gray-300 max-h-[60vh] overflow-y-auto pr-2">
          <div>
            <p className="leading-relaxed mb-3">
              本实验室使用{" "}
              <a
                href="https://v0.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white hover:text-gray-300 underline"
              >
                v0
              </a>{" "}
              构建，让你在同一界面使用多家服务商的模型生成图像。所有 API 调用均通过{" "}
              <a
                href="https://vercel.com/ai-gateway"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white hover:text-gray-300 underline"
              >
                Vercel AI Gateway
              </a>{" "}
              提供企业级请求路由与缓存。
            </p>
            <p className="leading-relaxed text-white/90">
              你可以从 v0 克隆本实验室，配置自己的 Vercel AI Gateway 凭据，构建专属应用。
            </p>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">模型</h3>
            <p className="leading-relaxed mb-2">选择 AI Gateway 提供的图像模型：</p>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>
                <span className="font-semibold text-white">OpenAI:</span> GPT Image 2 和 GPT Image 1.5
              </li>
              <li>
                <span className="font-semibold text-white">Google:</span> Gemini 3.1 Flash, Gemini 3 Pro, Gemini 2.5 Flash（图像版）
              </li>
              <li>
                <span className="font-semibold text-white">xAI:</span> Grok Imagine
              </li>
              <li>
                <span className="font-semibold text-white">Black Forest Labs:</span> FLUX.2 Max 和 FLUX.2 Pro
              </li>
              <li>
                <span className="font-semibold text-white">Recraft 与字节跳动：</span> Recraft V4.1 Pro, Seedream 4.0–5.0
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">各模型专属设置</h3>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>
                <span className="font-semibold text-white">GPT Image 画质：</span> 自动、低、中或高（计算资源越多，图像保真度越高）
              </li>
              <li>
                <span className="font-semibold text-white">Gemini 3.1 Flash:</span> 思考深度（简要／深入）、最高 4K 分辨率，以及 Google 搜索参考
              </li>
              <li>
                <span className="font-semibold text-white">宽高比：</span> 仅显示当前模型支持的比例；切换模型或拖入图片时，会自动选择最接近的可用比例
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">技术概览</h3>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>
                <span className="font-semibold text-white">无需登录：</span> 当前版本无需账号，生成历史保存在当前浏览器中
              </li>
              <li>
                <span className="font-semibold text-white">持久化生成任务：</span> 每次请求均由 Vercel Workflow 执行，支持重启后继续运行和恢复
              </li>
              <li>
                <span className="font-semibold text-white">图片处理：</span> 在客户端转换为 Base64，并校验格式与大小
              </li>
              <li>
                <span className="font-semibold text-white">生成结果：</span> 存储于 Vercel Blob，不添加水印
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">图像编辑</h3>
            <p className="leading-relaxed mb-2">
              上传一到两张参考图片，并输入编辑指令：
            </p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>拖放图片，或通过文件选择器上传</li>
              <li>直接粘贴图片链接</li>
              <li>支持 PNG、JPG、WebP、GIF（提交至服务器的单张图片不超过 10 MB）</li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">键盘快捷键</h3>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>
                <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">⌘/Ctrl + Enter</kbd> — 生成图像
              </li>
              <li>
                <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">⌘/Ctrl + C</kbd> — 将图片复制到剪贴板
              </li>
              <li>
                <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">⌘/Ctrl + D</kbd> — 下载图片
              </li>
              <li>
                <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">⌘/Ctrl + U</kbd> — 将生成的图片用作参考图片
              </li>
              <li>
                <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">Esc</kbd> — 关闭全屏查看器
              </li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
