"use client"

import type { ProviderSettings } from "@/lib/api-provider-types"
import type React from "react"

import { useState, useEffect, useRef, useCallback } from "react"
import type { Generation, GenerationPhase, ModelType, ThinkingLevel, Resolution, Quality } from "../types"

interface UseImageGenerationProps {
  providerSettings: ProviderSettings
  prompt: string
  aspectRatio: string
  image1: File | null
  image2: File | null
  image1Url: string
  image2Url: string
  useUrls: boolean
  selectedModel: ModelType
  thinkingLevel: ThinkingLevel
  resolution: Resolution
  quality: Quality
  useGrounding: boolean
  generations: Generation[]
  setGenerations: React.Dispatch<React.SetStateAction<Generation[]>>
  addGeneration: (generation: Generation) => Promise<void>
  onToast: (message: string, type?: "success" | "error") => void
  onImageUpload: (file: File, imageNumber: 1 | 2) => Promise<void>
}

interface GenerateImageOptions {
  prompt?: string
  aspectRatio?: string
  image1?: File | null
  image2?: File | null
  image1Url?: string
  image2Url?: string
  useUrls?: boolean
  selectedModel?: ModelType
  thinkingLevel?: ThinkingLevel
  resolution?: Resolution
  quality?: Quality
  useGrounding?: boolean
}

let sharedAudioContext: AudioContext | null = null

const playSuccessSound = () => {
  try {
    if (!sharedAudioContext) {
      sharedAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    }

    const oscillator = sharedAudioContext.createOscillator()
    const gainNode = sharedAudioContext.createGain()

    oscillator.connect(gainNode)
    gainNode.connect(sharedAudioContext.destination)

    oscillator.frequency.setValueAtTime(659.25, sharedAudioContext.currentTime)

    gainNode.gain.setValueAtTime(0.15, sharedAudioContext.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.01, sharedAudioContext.currentTime + 0.15)

    oscillator.start(sharedAudioContext.currentTime)
    oscillator.stop(sharedAudioContext.currentTime + 0.15)
  } catch (error) {
    console.log("Could not play sound:", error)
  }
}

const getPhaseFromProgress = (progress: number): GenerationPhase => {
  if (progress < 20) return "sending"
  if (progress < 80) return "generating"
  if (progress < 95) return "processing"
  return "loading"
}

// Adaptive progress: calibrated from real generation durations.
// Module-level so it persists across re-renders and updates mid-session.
// No backing database here, so we just start from a sane default and let
// expectedDurationMs self-calibrate from each completed generation below.
let expectedDurationMs = 35_000

function fetchExpectedDuration() {
  // No-op: this template has no database to read historical stats from.
}

/** Two-phase progress curve:
 *  Phase 1 (0→90%): fast ease-out over expectedDurationMs
 *  Phase 2 (90→99%): slow crawl that never stops — user always sees movement */
function adaptiveProgress(elapsedMs: number): number {
  const t = elapsedMs / expectedDurationMs
  if (t < 1) {
    // Phase 1: 0→90% over the expected duration
    return 90 * (1 - Math.exp(-3 * t))
  }
  // Phase 2: 90→99%, asymptotically approaching 99
  // Each additional expectedDuration gets ~half the remaining distance
  const overtime = t - 1
  return 90 + 9 * (1 - Math.exp(-0.5 * overtime))
}

export function useImageGeneration({
  providerSettings,
  prompt,
  aspectRatio,
  image1,
  image2,
  image1Url,
  image2Url,
  useUrls,
  selectedModel,
  thinkingLevel,
  resolution,
  quality,
  useGrounding,
  generations,
  setGenerations,
  addGeneration,
  onToast,
  onImageUpload,
}: UseImageGenerationProps) {
  const [selectedGenerationId, setSelectedGenerationId] = useState<string | null>(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  const controllers = useRef<Map<string, AbortController>>(new Map())
  const stopProgressMap = useRef<Map<string, () => void>>(new Map())

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort()
    for (const stop of stopProgressMap.current.values()) stop()
    controllers.current.clear()
    stopProgressMap.current.clear()
  }, [])

  const cancelGeneration = (generationId: string) => {
    const generation = generations.find((g) => g.id === generationId)
    if (generation?.abortController) {
      generation.abortController.abort()
    }

    controllers.current.get(generationId)?.abort()
    controllers.current.delete(generationId)
    stopProgressMap.current.get(generationId)?.()
    stopProgressMap.current.delete(generationId)

    // Remove entirely — don't leave a "cancelled" thumbnail
    setGenerations((prev) => prev.filter((gen) => gen.id !== generationId))
    onToast("已取消生成", "error")
  }

  const generateImage = async (options?: GenerateImageOptions) => {
    if (!providerSettings.baseUrl || !providerSettings.apiKey) {
      onToast("请先打开 API 设置并填写 Base URL 和 Token。", "error")
      return
    }
    if (!(options?.selectedModel ?? selectedModel).trim()) {
      onToast("请选择模型或手动填写模型 ID。", "error")
      return
    }
    fetchExpectedDuration()
    const effectivePrompt = options?.prompt ?? prompt
    const effectiveAspectRatio = options?.aspectRatio ?? aspectRatio
    const effectiveImage1 = options?.image1 !== undefined ? options.image1 : image1
    const effectiveImage2 = options?.image2 !== undefined ? options.image2 : image2
    const effectiveImage1Url = options?.image1Url !== undefined ? options.image1Url : image1Url
    const effectiveImage2Url = options?.image2Url !== undefined ? options.image2Url : image2Url
    const effectiveUseUrls = options?.useUrls !== undefined ? options.useUrls : useUrls
    const effectiveSelectedModel = options?.selectedModel !== undefined ? options.selectedModel : selectedModel
    const effectiveThinkingLevel = options?.thinkingLevel !== undefined ? options.thinkingLevel : thinkingLevel
    const effectiveResolution = options?.resolution !== undefined ? options.resolution : resolution
    const effectiveQuality = options?.quality !== undefined ? options.quality : quality
    const effectiveUseGrounding = options?.useGrounding !== undefined ? options.useGrounding : useGrounding

    const hasImages = effectiveUseUrls ? effectiveImage1Url || effectiveImage2Url : effectiveImage1 || effectiveImage2
    const currentMode = hasImages ? "image-editing" : "text-to-image"

    if (currentMode === "image-editing" && !effectiveUseUrls && !effectiveImage1) {
      onToast("编辑模式下请至少上传一张图片", "error")
      return
    }
    if (currentMode === "image-editing" && effectiveUseUrls && !effectiveImage1Url) {
      onToast("编辑模式下请至少提供一个图片链接", "error")
      return
    }
    if (!effectivePrompt.trim()) {
      onToast("请输入提示词", "error")
      return
    }

    const numVariations = 1
    const generationPromises = []

    for (let i = 0; i < numVariations; i++) {
      const generationId = `gen-${Date.now()}-${Math.random().toString(36).substring(7)}`
      const controller = new AbortController()
      controllers.current.set(generationId, controller)

      const newGeneration: Generation = {
        id: generationId,
        status: "loading",
        progress: 0,
        phase: "sending",
        imageUrl: null,
        prompt: effectivePrompt,
        timestamp: Date.now() + i,
        abortController: controller,
      }

      setGenerations((prev) => [newGeneration, ...prev])

      if (i === 0) {
        setSelectedGenerationId(generationId)
      }

      let isRunning = true
      let rafId: number
      const startTime = performance.now()
      let lastUpdateTime = startTime
      let currentProgress = 0

      const updateProgress = (currentTime: number) => {
        if (!isRunning) return

        const deltaTime = currentTime - lastUpdateTime

        // Update every 50ms for smooth animation
        if (deltaTime >= 50) {
          lastUpdateTime = currentTime
          const elapsedMs = currentTime - startTime
          currentProgress = adaptiveProgress(elapsedMs)
          const phase = getPhaseFromProgress(currentProgress)

          setGenerations((prev) =>
            prev.map((gen) =>
              gen.id === generationId && gen.status === "loading" ? { ...gen, progress: currentProgress, phase } : gen,
            ),
          )
        }

        rafId = requestAnimationFrame(updateProgress)
      }

      rafId = requestAnimationFrame(updateProgress)

      const stopProgress = () => {
        isRunning = false
        cancelAnimationFrame(rafId)
      }

      stopProgressMap.current.set(generationId, stopProgress)

      const generationPromise = (async () => {
        try {
          const formData = new FormData()
          formData.append("baseUrl", providerSettings.baseUrl)
          formData.append("apiKey", providerSettings.apiKey)
          formData.append("apiMode", providerSettings.apiMode)
          formData.append("mode", currentMode)
          formData.append("prompt", effectivePrompt)
          formData.append("aspectRatio", effectiveAspectRatio)
          formData.append("selectedModel", effectiveSelectedModel)
          formData.append("thinkingLevel", effectiveThinkingLevel)
          formData.append("resolution", effectiveResolution)
          formData.append("quality", effectiveQuality)
          formData.append("useGrounding", String(effectiveUseGrounding))

          if (currentMode === "image-editing") {
            if (effectiveUseUrls) {
              formData.append("image1Url", effectiveImage1Url)
              if (effectiveImage2Url) {
                formData.append("image2Url", effectiveImage2Url)
              }
            } else {
              if (effectiveImage1) {
                formData.append("image1", effectiveImage1)
              }
              if (effectiveImage2) {
                formData.append("image2", effectiveImage2)
              }
            }
          }

          // Generate through the configured relay; credentials are never added to history.
          const response = await fetch("/api/generate-image", {
            method: "POST",
            body: formData,
            signal: controller.signal,
          })

          if (response.status === 429) {
            const errorData = await response.json()
            stopProgress()
            setGenerations((prev) => prev.filter((gen) => gen.id !== generationId))
            onToast(errorData.error || "服务暂时不可用，请稍后重试。", "error")
            return
          }

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: "未知错误" }))
            // Prefer actionable server details when present.
            throw new Error(errorData.details || errorData.error || "生成图像失败")
          }

          const data = await response.json()
          controllers.current.delete(generationId)

          if (data.durationMs && data.durationMs > 0) {
            expectedDurationMs = data.durationMs
          }

          if (data.url) {
            // Set the URL while keeping status "loading" — the component renders
            // the image behind the progress bar. When the image's onLoad fires,
            // markGenerationComplete removes the progress bar instantly (0ms gap).
            setGenerations((prev) =>
              prev.map((gen) =>
                gen.id === generationId && gen.status === "loading"
                  ? { ...gen, imageUrl: data.url, aspectRatio: effectiveAspectRatio, mode: currentMode }
                  : gen,
              ),
            )
            // Don't stopProgress or playSound — markGenerationComplete handles that
            // when the actual <Image> onLoad fires in the component.
          } else {
            stopProgress()
            stopProgressMap.current.delete(generationId)
          }
        } catch (error) {
          controllers.current.delete(generationId)
          stopProgress()
          stopProgressMap.current.delete(generationId)

          if (error instanceof Error && error.name === "AbortError") {
            return
          }

          const errorMessage = error instanceof Error ? error.message : "发生了未知错误"

          setGenerations((prev) => prev.filter((gen) => gen.id !== generationId))

          onToast(/[\u3400-\u9fff]/.test(errorMessage) ? errorMessage : "生成失败，请检查网络连接后重试。", "error")
        }
      })()

      generationPromises.push(generationPromise)
    }

    await Promise.all(generationPromises)
  }

  const loadGeneratedAsInput = async () => {
    const selectedGeneration = generations.find((g) => g.id === selectedGenerationId)
    if (!selectedGeneration?.imageUrl) return

    try {
      const response = await fetch(selectedGeneration.imageUrl)
      const blob = await response.blob()
      const file = new File([blob], "generated-image.png", { type: "image/png" })

      await onImageUpload(file, 1)
      onToast("图片已载入为第一张参考图片", "success")
    } catch (error) {
      console.error("Error loading image as input:", error)
      onToast("图片加载失败", "error")
    }
  }

  // Called by the component when the <Image> onLoad fires.
  // At that point the image is decoded and painted — safe to remove progress bar.
  const markGenerationComplete = useCallback((generationId: string) => {
    // Stop the progress animation
    const stopFn = stopProgressMap.current.get(generationId)
    if (stopFn) {
      stopFn()
      stopProgressMap.current.delete(generationId)
    }

    const gen = generations.find((item) => item.id === generationId)
    if (!gen || gen.status !== "loading" || !gen.imageUrl) return
    const completedGen: Generation = {
      ...gen, status: "complete", progress: 100, phase: undefined,
      timestamp: Date.now(), abortController: undefined,
    }
    setImageLoaded(true)
    playSuccessSound()
    addGeneration(completedGen).catch(() => {})
  }, [generations, setImageLoaded, addGeneration])

  const markGenerationFailed = useCallback((generationId: string) => {
    stopProgressMap.current.get(generationId)?.()
    stopProgressMap.current.delete(generationId)
    setGenerations(prev => prev.filter(gen => gen.id !== generationId))
    onToast("图片无法加载，接口可能返回了损坏的图片。", "error")
  }, [setGenerations, onToast])

  return {
    selectedGenerationId,
    setSelectedGenerationId,
    imageLoaded,
    setImageLoaded,
    generateImage,
    cancelGeneration,
    loadGeneratedAsInput,
    markGenerationComplete,
    markGenerationFailed,
  }
}
