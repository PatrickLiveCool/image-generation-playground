"use client"

import { useCallback, useEffect, useState } from "react"
import { useAccountVisible } from "@/components/account/account-visibility"
import { privateRequest } from "@/lib/private-workspace-client"
import { createEmptyAnnotationSnapshot, type AnnotationImageMetadata } from "@/lib/image-annotations"

/** Each response belongs to one asset and one visible account lifetime. */
export function useAnnotationMetadata(imageUrl: string | null | undefined, baseVersionId: string | undefined): { key?: string; metadata?: AnnotationImageMetadata; error?: string; retry: () => void } {
  const visible = useAccountVisible()
  const [state, setState] = useState<{ key: string; metadata?: AnnotationImageMetadata; error?: string }>({ key: "" })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => { if (visible) setAttempt(value => value + 1) }, [visible])
  const key = `${baseVersionId ?? ""}:${imageUrl ?? ""}:${attempt}`
  useEffect(() => {
    if (!visible || !baseVersionId || !imageUrl || !/^\/api\/images\/[0-9a-f-]{36}$/i.test(imageUrl)) return
    const controller = new AbortController()
    setState({ key })
    void privateRequest(`${imageUrl}/metadata`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return
      const metadata = value as AnnotationImageMetadata
      if (!metadata || imageUrl !== `/api/images/${metadata.assetId}`) throw new Error("图片元数据与当前基准不匹配。")
      if (metadata.pages !== 1) throw new Error("当前图片包含多帧，暂不能添加区域批注。")
      createEmptyAnnotationSnapshot(baseVersionId, metadata as AnnotationImageMetadata & { pages: 1 })
      setState({ key, metadata })
    }).catch(error => { if (!controller.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "图片信息未能读取，仍可使用普通修改。" }) })
    return () => controller.abort()
  }, [key, imageUrl, baseVersionId, visible])
  if (!visible) return { error: "账号状态正在检查，暂不能绘制。", retry }
  return { ...(state.key === key ? state : { key }), retry }
}
