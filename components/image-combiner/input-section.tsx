"use client"

import type React from "react"
import { memo, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip"
import { Trash2, Search, Settings2 } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ImageUploadBox } from "./image-upload-box"
import { ModelSelector } from "./model-selector"
import { cn } from "@/lib/utils"
import { isImageFile } from "@/lib/image-utils"
import type { ModelType, ThinkingLevel, Resolution, Quality } from "./types"

const btnClassName = "w-full h-10 md:h-12 text-sm md:base font-semibold bg-white text-black hover:bg-gray-200"

interface InputSectionProps {
  prompt: string
  setPrompt: (prompt: string) => void
  aspectRatio: string
  setAspectRatio: (ratio: string) => void
  availableAspectRatios: Array<{ value: string; label: string; icon: React.ReactNode }>
  selectedModel: ModelType
  setSelectedModel: (model: ModelType) => void
  thinkingLevel: ThinkingLevel
  setThinkingLevel: (level: ThinkingLevel) => void
  resolution: Resolution
  setResolution: (res: Resolution) => void
  quality: Quality
  setQuality: (q: Quality) => void
  useGrounding: boolean
  setUseGrounding: (use: boolean) => void
  useUrls: boolean
  setUseUrls: (use: boolean) => void
  image1Preview: string | null
  image2Preview: string | null
  image1: File | null
  image1Url: string
  image2Url: string
  canGenerate: boolean
  hasImages: boolean
  onGenerate: () => void
  onToast: (message: string, type?: "success" | "error") => void
  onClearAll: () => void
  onImageUpload: (file: File, slot: 1 | 2) => Promise<void>
  onUrlChange: (url: string, slot: 1 | 2) => void
  onClearImage: (slot: 1 | 2) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPromptPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onImageFullscreen: (url: string) => void
  promptTextareaRef: React.RefObject<HTMLTextAreaElement | null>
}

export const InputSection = memo(function InputSection({
  prompt,
  setPrompt,
  aspectRatio,
  setAspectRatio,
  availableAspectRatios,
  selectedModel,
  setSelectedModel,
  thinkingLevel,
  setThinkingLevel,
  resolution,
  setResolution,
  quality,
  setQuality,
  useGrounding,
  setUseGrounding,
  useUrls,
  setUseUrls,
  image1Preview,
  image2Preview,
  image1,
  image1Url,
  image2Url,
  canGenerate,
  hasImages,
  onGenerate,
  onToast,
  onClearAll,
  onImageUpload,
  onUrlChange,
  onClearImage,
  onKeyDown,
  onPromptPaste,
  onImageFullscreen,
  promptTextareaRef,
}: InputSectionProps) {
  const handleFile1Change = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        onImageUpload(file, 1)
        e.target.value = ""
      }
    },
    [onImageUpload],
  )

  const handleFile2Change = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) {
        onImageUpload(file, 2)
        e.target.value = ""
      }
    },
    [onImageUpload],
  )

  const handleDrop1 = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (file && isImageFile(file)) {
        onImageUpload(file, 1)
      }
    },
    [onImageUpload],
  )

  const handleDrop2 = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (file && isImageFile(file)) {
        onImageUpload(file, 2)
      }
    },
    [onImageUpload],
  )

  const handleClearImage1 = useCallback(() => onClearImage(1), [onClearImage])
  const handleClearImage2 = useCallback(() => onClearImage(2), [onClearImage])

  const handleSelectImage1 = useCallback(() => {
    if (image1Preview) {
      onImageFullscreen(image1Preview)
    } else {
      document.getElementById("file1")?.click()
    }
  }, [image1Preview, onImageFullscreen])

  const handleSelectImage2 = useCallback(() => {
    if (image2Preview) {
      onImageFullscreen(image2Preview)
    } else {
      document.getElementById("file2")?.click()
    }
  }, [image2Preview, onImageFullscreen])

  const handleUrl1Change = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUrlChange(e.target.value, 1)
    },
    [onUrlChange],
  )

  const handleUrl2Change = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUrlChange(e.target.value, 2)
    },
    [onUrlChange],
  )

  const handlePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setPrompt(e.target.value)
    },
    [setPrompt],
  )

  const handleModelChange = useCallback((value: string) => {
    setSelectedModel(value as ModelType)
  }, [setSelectedModel])

  const toggleUrls = useCallback((value: boolean) => () => setUseUrls(value), [setUseUrls])

  return (
    <TooltipProvider>
      <div className="flex flex-col">
        <div className="flex flex-col gap-2 md:gap-3">
          <div className="flex flex-col gap-2 md:gap-3">
            <div className="flex items-center justify-between mb-1 md:mb-2 select-none min-w-0">
              <div className="flex flex-col gap-1 flex-shrink-0">
                <label className="text-sm md:text-base font-medium text-gray-300">提示词</label>
              </div>
              <div className="flex items-center gap-1.5 md:gap-2 min-w-0 flex-shrink overflow-hidden">
                <ModelSelector value={selectedModel} onChange={setSelectedModel} />
                {(selectedModel === "google/gemini-3.1-flash-image-preview" || selectedModel.startsWith("openai/")) && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button aria-label="设置" className="h-7 md:h-10 px-2 bg-black/50 border border-gray-600 text-gray-300 hover:text-white hover:border-gray-500 transition-all">
                      <Settings2 className="w-3.5 h-3.5 md:w-4 md:h-4" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-64 bg-black/95 border-gray-600 text-white p-3 space-y-3">
                    {selectedModel === "google/gemini-3.1-flash-image-preview" && (
                      <>
                        <div className="space-y-1.5">
                          <label className="text-[10px] md:text-xs text-gray-400 uppercase tracking-wider">思考深度</label>
                          <p className="text-[10px] text-gray-500">模型在生成图像前的推理深度</p>
                          <div className="inline-flex w-full bg-black/50 border border-gray-600">
                            <button
                              onClick={() => setThinkingLevel("minimal")}
                              className={cn(
                                "flex-1 px-2 py-1.5 text-xs font-medium transition-all",
                                thinkingLevel === "minimal" ? "bg-white text-black" : "text-gray-300 hover:text-white",
                              )}
                            >
                              简要
                            </button>
                            <button
                              onClick={() => setThinkingLevel("high")}
                              className={cn(
                                "flex-1 px-2 py-1.5 text-xs font-medium transition-all",
                                thinkingLevel === "high" ? "bg-white text-black" : "text-gray-300 hover:text-white",
                              )}
                            >
                              深入
                            </button>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] md:text-xs text-gray-400 uppercase tracking-wider">分辨率</label>
                          <p className="text-[10px] text-gray-500">输出图像的尺寸</p>
                          <div className="inline-flex w-full bg-black/50 border border-gray-600">
                            {(["1K", "2K", "4K"] as const).map((r) => (
                              <button
                                key={r}
                                onClick={() => setResolution(r)}
                                className={cn(
                                  "flex-1 px-2 py-1.5 text-xs font-medium transition-all",
                                  resolution === r ? "bg-white text-black" : "text-gray-300 hover:text-white",
                                )}
                              >
                                {r}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[10px] md:text-xs text-gray-400 uppercase tracking-wider">联网搜索</label>
                          <p className="text-[10px] text-gray-500">参考实时网页搜索结果生成图像</p>
                          <button
                            onClick={() => setUseGrounding(!useGrounding)}
                            className={cn(
                              "flex items-center gap-2 w-full px-2 py-1.5 text-xs font-medium border transition-all",
                              useGrounding
                                ? "bg-white text-black border-white"
                                : "bg-black/50 border-gray-600 text-gray-300 hover:text-white hover:border-gray-500",
                            )}
                          >
                            <Search className="w-3 h-3 flex-shrink-0" />
                            <span className="whitespace-nowrap">Google 搜索</span>
                          </button>
                        </div>
                      </>
                    )}
                    {selectedModel.startsWith("openai/") && (
                      <div className="space-y-1.5">
                        <label className="text-[10px] md:text-xs text-gray-400 uppercase tracking-wider">画质</label>
                        <p className="text-[10px] text-gray-500">画质越高，所需计算资源越多</p>
                        <div className="inline-flex w-full bg-black/50 border border-gray-600">
                          {(["auto", "low", "medium", "high"] as const).map((q) => (
                            <button
                              key={q}
                              onClick={() => setQuality(q)}
                              className={cn(
                                "flex-1 px-2 py-1.5 text-xs font-medium transition-all capitalize",
                                quality === q ? "bg-white text-black" : "text-gray-300 hover:text-white",
                              )}
                            >
                              {{ auto: "自动", low: "低", medium: "中", high: "高" }[q]}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
                )}
                <Select value={aspectRatio} onValueChange={setAspectRatio}>
                  <SelectTrigger aria-label="选择宽高比" className="w-[72px] md:w-[115px] !h-7 md:!h-10 px-2 md:px-3 !py-0 bg-black/50 border border-gray-600 text-white text-xs md:text-sm focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:ring-0 data-[state=open]:ring-offset-0">
                    <SelectValue placeholder="1:1" />
                  </SelectTrigger>
                  <SelectContent className="bg-black/95 border-gray-600 text-white">
                    {availableAspectRatios.map((option) => (
                      <SelectItem key={option.value} value={option.value} textValue={option.label} className="text-xs md:text-sm">
                        <div className="flex items-center gap-2">
                          <span className="hidden md:inline">{option.icon}</span>
                          <span>{option.label}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={onClearAll}
                  disabled={!prompt.trim() && !hasImages}
                  variant="outline"
                  aria-label="清空全部"
                  className="h-7 md:h-10 px-3 py-0 text-xs md:text-sm bg-transparent border border-gray-600 text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  <Trash2 className="size-4 md:hidden" />
                  <span className="hidden md:inline">清空</span>
                </Button>
              </div>
            </div>
            <textarea
              ref={promptTextareaRef}
              value={prompt}
              onChange={handlePromptChange}
              onKeyDown={onKeyDown}
              onPaste={onPromptPaste}
              placeholder=""
              aria-label="图像生成提示词"
              autoFocus
              className="w-full flex-1 min-h-[60px] max-h-[100px] sm:min-h-[100px] sm:max-h-[140px] lg:min-h-[12vh] lg:max-h-[18vh] xl:min-h-[14vh] xl:max-h-[20vh] p-2 md:p-4 bg-black/50 border-2 border-gray-600 resize-none focus:outline-none focus:border-white text-white text-xs md:text-base select-text"
              style={{
                fontSize: "16px",
                WebkitUserSelect: "text",
                userSelect: "text",
              }}
            />
          </div>

          <div className="flex flex-col gap-2 md:gap-3">
            <div>
              <div className="flex items-center justify-between mb-1 md:mb-2 select-none min-w-0">
                <div className="flex flex-col gap-1">
                  <label className="text-sm md:text-base font-medium text-gray-300">参考图片（可选）</label>
                </div>
                <div className="inline-flex bg-black/50 border border-gray-600">
                  <button
                    onClick={toggleUrls(false)}
                    className={cn(
                      "px-2 py-1 md:px-4 md:py-2 text-xs md:text-sm font-medium transition-all",
                      !useUrls ? "bg-white text-black" : "text-gray-300 hover:text-white",
                    )}
                  >
                    文件
                  </button>
                  <button
                    onClick={toggleUrls(true)}
                    className={cn(
                      "px-2 py-1 md:px-4 md:py-2 text-xs md:text-sm font-medium transition-all",
                      useUrls ? "bg-white text-black" : "text-gray-300 hover:text-white",
                    )}
                  >
                    链接
                  </button>
                </div>
              </div>

              {useUrls ? (
                <div className="space-y-2 lg:min-h-[12vh] xl:min-h-[14vh]">
                  <div className="relative">
                    <input
                      type="url"
                      value={image1Url}
                      onChange={handleUrl1Change}
                      placeholder="第一张图片的链接"
                      aria-label="第一张图片的链接"
                      className="w-full p-2 md:p-3 pr-8 bg-black/50 border border-gray-600 text-white text-xs focus:outline-none focus:ring-2 focus:ring-white select-text"
                    />
                    {image1Url && (
                      <button
                        onClick={handleClearImage1}
                        aria-label="清空第一张图片的链接"
                        className="absolute right-1 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type="url"
                      value={image2Url}
                      onChange={handleUrl2Change}
                      placeholder="第二张图片的链接"
                      aria-label="第二张图片的链接"
                      className="w-full p-2 md:p-3 pr-8 bg-black/50 border border-gray-600 text-white text-xs focus:outline-none focus:ring-2 focus:ring-white select-text"
                    />
                    {image2Url && (
                      <button
                        onClick={handleClearImage2}
                        aria-label="清空第二张图片的链接"
                        className="absolute right-1 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="select-none lg:min-h-[12vh] xl:min-h-[14vh]">
                  <div className="grid grid-cols-2 gap-2 sm:gap-3 md:gap-4 w-full">
                    <ImageUploadBox
                      imageNumber={1}
                      preview={image1Preview}
                      onDrop={handleDrop1}
                      onClear={handleClearImage1}
                      onSelect={handleSelectImage1}
                    />
                    <input
                      id="file1"
                      type="file"
                      accept="image/*,.heic,.heif"
                      className="hidden"
                      onChange={handleFile1Change}
                    />

                    <ImageUploadBox
                      imageNumber={2}
                      preview={image2Preview}
                      onDrop={handleDrop2}
                      onClear={handleClearImage2}
                      onSelect={handleSelectImage2}
                    />
                    <input
                      id="file2"
                      type="file"
                      accept="image/*,.heic,.heif"
                      className="hidden"
                      onChange={handleFile2Change}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="pt-0">
            <div className="flex items-center gap-2">
              <Button onClick={onGenerate} disabled={!canGenerate} className={btnClassName}>
                生成图像
              </Button>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
})
