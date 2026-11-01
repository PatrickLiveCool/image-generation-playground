"use client"

import { useCallback, useEffect, useRef } from "react"
import type { ModelMapping, ProviderSettings } from "@/lib/api-provider-types"
import { ACCOUNT_SESSION_RECHECK_EVENT } from "@/lib/account-client"
import { buildCreationRequest } from "@/lib/creation-request"
import type { CreativeWorkspaceController } from "./use-creative-workspace"

interface RunningRequest {
  id: string
  controller: AbortController
  timer: ReturnType<typeof setInterval>
}

/** Owned by the workspace, so changing the visible creation cannot cancel or redirect a request. */
export function useCreationGeneration(
  workspace: CreativeWorkspaceController,
  settings: ProviderSettings,
  mappings: ModelMapping[],
  onToast: (message: string, type?: "success" | "error") => void,
) {
  const requests = useRef(new Map<string, RunningRequest>())
  const { getCreation, startGeneration, updateGeneration, completeGeneration, failGeneration } = workspace

  useEffect(() => {
    const running = requests.current
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!running.size) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => {
      window.removeEventListener("beforeunload", beforeUnload)
      for (const request of running.values()) {
        clearInterval(request.timer)
        request.controller.abort()
      }
      running.clear()
    }
  }, [])

  const generate = useCallback(async (creationId: string) => {
    if (requests.current.has(creationId)) return
    const creation = getCreation(creationId)
    if (!creation) return

    let prepared: ReturnType<typeof buildCreationRequest>
    try {
      prepared = buildCreationRequest({ creation, settings, mappings })
    } catch (error) {
      onToast(error instanceof Error ? error.message : "请检查本轮输入。", "error")
      return
    }
    const { formData, generation } = prepared
    if (!startGeneration(creationId, generation)) return
    const controller = new AbortController()
    const startedAt = Date.now()
    // This is a waiting indicator, not progress reported by the provider.
    const timer = setInterval(() => {
      updateGeneration(creationId, generation.id, {
        progress: Math.min(92, 5 + 87 * (1 - Math.exp(-(Date.now() - startedAt) / 70_000))),
        phase: "generating",
      })
    }, 1000)
    requests.current.set(creationId, { id: generation.id, controller, timer })

    try {
      const response = await fetch("/api/generate-image", { method: "POST", body: formData, signal: controller.signal })
      const result = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 401 || result?.error?.code === "PASSWORD_CHANGE_REQUIRED") {
          window.dispatchEvent(new Event(ACCOUNT_SESSION_RECHECK_EVENT))
        }
        throw new Error(typeof result?.error === "string" ? result.error
          : typeof result?.error?.message === "string" ? result.error.message : "生成未完成，请稍后重试。")
      }
      if (typeof result?.url !== "string" || !result.url) throw new Error("接口没有返回图片，请检查中转的图片接口设置。")
      if (controller.signal.aborted) return
      // Completion is independent of the visible <img> decoding the result.
      completeGeneration(creationId, generation.id, { imageUrl: result.url })
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error && /[\u3400-\u9fff]/.test(error.message)
        ? error.message : "连接中断，生成结果尚未确认。原图和输入已保留，请确认后重试。"
      failGeneration(creationId, generation.id, message)
      onToast(message, "error")
    } finally {
      clearInterval(timer)
      if (requests.current.get(creationId)?.id === generation.id) requests.current.delete(creationId)
    }
  }, [settings, mappings, getCreation, startGeneration, updateGeneration, completeGeneration, failGeneration, onToast])

  const cancel = useCallback((creationId: string, generationId: string) => {
    const request = requests.current.get(creationId)
    if (!request || request.id !== generationId) return
    request.controller.abort()
    clearInterval(request.timer)
    requests.current.delete(creationId)
    failGeneration(creationId, generationId, "已停止等待，原图和输入已保留；中转可能仍在处理本次请求。")
  }, [failGeneration])

  return { generate, cancel }
}
