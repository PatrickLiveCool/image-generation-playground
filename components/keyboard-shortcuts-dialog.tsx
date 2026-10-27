"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useIsMobile } from "@/hooks/use-mobile"

interface KeyboardShortcutsDialogProps {
  triggerVariant?: "default" | "icon-only"
}

export function KeyboardShortcutsDialog({ triggerVariant = "default" }: KeyboardShortcutsDialogProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  const shortcuts = [
    { key: "Shift + Enter", description: "生成图像（也支持 Cmd/Ctrl + Enter）" },
    { key: "Cmd/Ctrl + V", description: "从剪贴板粘贴图片" },
    { key: "Cmd/Ctrl + C", description: "复制生成的图片" },
    { key: "Cmd/Ctrl + D", description: "下载图片" },
    { key: "Cmd/Ctrl + U", description: "用作参考图片" },
    { key: "Escape", description: "关闭全屏或对话框" },
    { key: "Cmd/Ctrl + /", description: "显示或隐藏快捷键说明" },
  ]

  if (isMobile) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {triggerVariant === "icon-only" ? (
          <button className="text-xs md:text-sm text-gray-400 hover:text-white transition-colors duration-200 flex items-center gap-2">
            <span className="text-xs font-mono bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5">?</span>
          </button>
        ) : (
          <button className="text-xs md:text-sm text-gray-400 hover:text-white transition-colors duration-200 flex items-center gap-2">
            <span>键盘快捷键</span>
            <span className="text-xs font-mono bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5">?</span>
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="bg-black border-gray-700 text-white max-w-md">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-4">
          {shortcuts.map((shortcut, i) => (
            <div key={i} className="flex justify-between items-center">
              <span className="text-gray-400">{shortcut.description}</span>
              <kbd className="px-2 py-1 text-xs font-mono bg-gray-800 border border-gray-600 rounded">
                {shortcut.key}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
