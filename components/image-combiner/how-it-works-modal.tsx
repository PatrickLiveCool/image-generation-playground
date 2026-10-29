"use client"

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

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
          <DialogDescription className="text-gray-400">使用管理员配置的模型，在同一项创作中持续修改并保留版本。</DialogDescription>
        </DialogHeader>
        <div className="space-y-6 text-sm text-gray-300 max-h-[60vh] overflow-y-auto pr-2">
          <p role="status" className="leading-relaxed text-amber-300">模型设置已可使用；账号私有生成链路仍在接入，本阶段暂不能生成或修改图片。以下介绍接通后的创作流程。</p>
          <div>
            <h3 className="text-lg font-semibold text-white mb-2">1. 配置你的 API</h3>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>由管理员在管理后台的“模型设置”中填写中转的 Base URL 和 Token。</li>
              <li>Base URL 使用完整的 HTTPS API 前缀；若中转地址包含 /v1，请一并填写。</li>
              <li>按中转说明选择 Images 或 Chat Completions 生图接口，然后保存配置。</li>
              <li>API 配置和模型映射由管理员统一保存；普通用户只需选择模型名称，无需填写 Token。</li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">2. 设置模型名称与映射</h3>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>管理员在 API 设置中读取模型，再添加“显示名称 → 实际模型”的映射；实际模型可从列表选择，也可手动填写 ID。</li>
              <li>名称由你决定，例如“极致”“均衡”。可新增、删除、调整顺序、改名或更换对应模型，没有固定档位。</li>
              <li>保存后，生成界面只显示你设置的名称；生成请求使用它对应的实际模型 ID。</li>
              <li>重新读取模型只更新可选列表，保留已有映射。若对应模型未出现在新列表中，会提示检查，不会自动替换。</li>
              <li>读取列表成功只表示模型接口可访问；请选用支持生图、且兼容所选接口的模型。</li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">3. 创建与持续修改</h3>
            <p className="leading-relaxed mb-2">新建创作，选择模型名称，输入画面描述和期望比例，点击“生成图片”。首版完成后，当前展示的图片会自动成为下一轮修改的基准。</p>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>继续填写修改要求，点击“修改 V1”等按钮即可生成新版本；按钮中的版本号表示本轮使用的基准图。</li>
              <li>想从旧版本继续时，在创作历史中选中它，再提交修改要求。已有版本都会保留。</li>
              <li>首次生成可添加最多两张参考图；修改已有版本时，可再添加一张补充参考图。提交的单张参考图不超过 10 MB。</li>
              <li>提示词下方可以上传 TXT、MD、CSV、JSON、HTML、XML、PDF 或 DOCX 文档，提交时原始文档会保存到私有 COS，服务端提取文字和可用图片后作为本轮上下文发送。</li>
              <li>修改会将基准图交给模型，但结果仍由模型生成，不能保证未提及的区域像素完全不变。</li>
              <li>比例选项按所选模型的能力展示，包含 1:1、9:16、16:9、4:3、3:4、3:2、2:3、5:4、4:5 和 21:9 中可用的选项。</li>
              <li>Images 接口会将比例转换为尺寸参数，Chat Completions 接口会在提示词中表达期望比例；实际输出仍由中转和模型决定。</li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">4. 管理创作与生成进度</h3>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>在“我的创作”中新建、切换或重命名创作。每项创作独立保存草稿、参考图和版本历史。</li>
              <li>一项创作生成期间，可以切换到其他创作继续工作；正在生成的创作暂时不能修改输入或切换基准版本。</li>
              <li>生成期间请保持网页打开。刷新或关闭后，未完成请求不会自动恢复；重新打开后可检查状态并手动重试。</li>
              <li>失败或取消会保留已有图片和本轮草稿。取消仅停止本页等待，不保证中转停止任务或计费。</li>
              <li>生成完成后可下载、复制或全屏查看。清空输入只清除本轮草稿和补充参考图，保留已有版本。</li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">数据保存</h3>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>创作信息、草稿、参考图文件和历史引用保存在本浏览器的 IndexedDB 中，不含 API Token；更换浏览器、设备或域名不会自动同步。</li>
              <li>清除浏览器数据会清除本地创作记录，不会删除对象存储中的文件。</li>
              <li>图片仅所属账号登录后可访问；分享图片链接不会授予其他账号访问权限。</li>
              <li>已提交的参考图、各轮产出和任务清单保存在私有对象存储中，应用服务器不保存图片文件。清单包含原始提示词及版本之间的来源关系，不含 API Token。</li>
              <li>模型调用使用管理员保存的共享配置，费用和可用能力以中转服务为准。</li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-white mb-2">键盘快捷键</h3>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>
                <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">Shift + Enter</kbd> — 提交当前生成或修改要求（也支持 ⌘/Ctrl + Enter）
              </li>
              <li>
                <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">⌘/Ctrl + C</kbd> — 将图片复制到剪贴板
              </li>
              <li>
                <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">⌘/Ctrl + D</kbd> — 下载图片
              </li>
              <li>
                <kbd className="px-1.5 py-0.5 bg-white/10 rounded text-xs">F</kbd> — 全屏查看当前图片（输入框外）
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
