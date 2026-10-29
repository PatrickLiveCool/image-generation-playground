"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useAccountVisible } from "@/components/account/account-visibility"
import { ACCOUNT_SESSION_RECHECK_EVENT } from "@/lib/account-client"

interface UseImageActionsProps { isMobile: boolean; currentMode: string; onToast: (message: string, type: "success" | "error") => void }
interface GeneratedImage { url: string; prompt: string }
interface SavedDocument { assetId: string; name: string }
type AssetKind = "images" | "documents"
interface Operation { lifetime: number; visibility: number; background?: boolean }
const DOCUMENT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "text/html", "application/xml", "text/xml", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"])

export function useImageActions({ currentMode, onToast }: UseImageActionsProps) {
  const [showFullscreen, setShowFullscreen] = useState(false)
  const [fullscreenImageUrl, setFullscreenImageUrl] = useState("")
  const accountVisible = useAccountVisible()
  const visibleRef = useRef(accountVisible)
  visibleRef.current = accountVisible
  const lifetime = useRef(0)
  const visibilityEpoch = useRef(0)
  const mounted = useRef(false)
  const requests = useRef(new Set<AbortController>())
  const popupRequests = useRef(new Set<AbortController>())
  const objectUrls = useRef(new Set<string>())
  const openedWindows = useRef(new Set<Window>())
  const releaseTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const invalidate = useCallback(() => {
    lifetime.current++
    for (const controller of requests.current) controller.abort()
    requests.current.clear()
    popupRequests.current.clear()
    for (const popup of openedWindows.current) popup.close()
    openedWindows.current.clear()
    for (const timer of releaseTimers.current) clearTimeout(timer)
    releaseTimers.current.clear()
    for (const url of objectUrls.current) URL.revokeObjectURL(url)
    objectUrls.current.clear()
  }, [])
  useEffect(() => {
    mounted.current = true
    const visibility = () => {
      if (document.visibilityState !== "hidden") return
      visibilityEpoch.current++
      // Opening a foreground tab hides this document. Only its explicitly opened
      // preview may continue; download/copy operations remain cancelled.
      for (const controller of requests.current) if (!popupRequests.current.has(controller)) controller.abort()
    }
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener(ACCOUNT_SESSION_RECHECK_EVENT, invalidate)
    window.addEventListener("pagehide", invalidate)
    return () => {
      mounted.current = false
      invalidate()
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener(ACCOUNT_SESSION_RECHECK_EVENT, invalidate)
      window.removeEventListener("pagehide", invalidate)
    }
  }, [invalidate])
  useEffect(() => { if (!accountVisible) invalidate() }, [accountVisible, invalidate])
  const valid = useCallback((epoch: Operation) => visibleRef.current && mounted.current && lifetime.current === epoch.lifetime
    && (epoch.background || (visibilityEpoch.current === epoch.visibility && document.visibilityState !== "hidden")), [])
  const releaseUrl = useCallback((url: string) => { URL.revokeObjectURL(url); objectUrls.current.delete(url) }, [])
  const makeUrl = useCallback((blob: Blob) => { const url = URL.createObjectURL(blob); objectUrls.current.add(url); return url }, [])
  const fetchAsset = useCallback(async (source: string, kind: AssetKind, epoch: Operation): Promise<Blob> => {
    const label = kind === "images" ? "图片" : "文档"
    if (!valid(epoch)) throw new Error(`${label}操作已取消。`)
    const url = new URL(source, window.location.origin)
    if (url.origin !== window.location.origin || !new RegExp(`^/api/${kind}/[0-9a-f-]{36}$`, "i").test(url.pathname) || url.search || url.hash) throw new Error(`${label}地址不可用，请刷新创作后重试。`)
    const controller = new AbortController()
    requests.current.add(controller)
    if (epoch.background) popupRequests.current.add(controller)
    try {
      const response = await fetch(url.pathname, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      if (response.status === 401 || response.status === 403) window.dispatchEvent(new Event(ACCOUNT_SESSION_RECHECK_EVENT))
      const mediaType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
      const acceptedType = kind === "images" ? /^image\/(png|jpeg|webp|gif)$/.test(mediaType)
        : DOCUMENT_TYPES.has(mediaType) && /^attachment(?:;|$)/i.test(response.headers.get("content-disposition") ?? "")
      if (!response.ok || !acceptedType) throw new Error(`${label}访问失败，请重新登录或刷新创作后重试。`)
      const blob = await response.blob()
      if (!blob.size || controller.signal.aborted || !valid(epoch)) throw new Error(`${label}操作已取消。`)
      return blob
    } finally { requests.current.delete(controller); popupRequests.current.delete(controller) }
  }, [valid])
  const fetchImage = useCallback((source: string, epoch: Operation) => fetchAsset(source, "images", epoch), [fetchAsset])
  const openFullscreen = useCallback((imageUrl: string) => {
    if (imageUrl) { setFullscreenImageUrl(imageUrl); setShowFullscreen(true); document.body.style.overflow = "hidden" }
  }, [])
  const closeFullscreen = useCallback(() => { setShowFullscreen(false); setFullscreenImageUrl(""); document.body.style.overflow = "unset" }, [])
  const downloadAsset = useCallback(async (source: string, kind: AssetKind, name: (blob: Blob) => string) => {
    const epoch: Operation = { lifetime: lifetime.current, visibility: visibilityEpoch.current }
    if (!valid(epoch)) return
    let url: string | undefined
    try {
      const blob = await fetchAsset(source, kind, epoch)
      if (!valid(epoch)) return
      url = makeUrl(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = name(blob).replace(/[\/\\\u0000-\u001f\u007f]/g, "_") || "document"
      document.body.appendChild(link); link.click(); link.remove()
    } catch (error) { if (valid(epoch)) onToast(error instanceof Error ? error.message : "文件下载失败。", "error") }
    finally { if (url) releaseUrl(url) }
  }, [fetchAsset, makeUrl, onToast, releaseUrl, valid])
  const downloadImage = useCallback(async (generatedImage: GeneratedImage | null) => {
    if (!generatedImage) return
    await downloadAsset(generatedImage.url, "images", blob => {
      const extension = blob.type.includes("jpeg") ? "jpg" : blob.type.split("/")[1]?.split(";")[0] || "png"
      return `image-${currentMode}-${Date.now()}.${extension}`
    })
  }, [currentMode, downloadAsset])
  const downloadDocument = useCallback(async (document: SavedDocument) => {
    await downloadAsset(`/api/documents/${document.assetId}`, "documents", () => document.name)
  }, [downloadAsset])
  const openImageInNewTab = useCallback(async (generatedImage: GeneratedImage | null) => {
    const epoch: Operation = { lifetime: lifetime.current, visibility: visibilityEpoch.current, background: true }
    if (!generatedImage || !valid(epoch) || document.visibilityState === "hidden") return
    // Keep the user gesture for popup permission; detach its opener before any I/O.
    let popup: Window | null
    try { popup = window.open("about:blank", "_blank") }
    catch { onToast("浏览器未能打开新窗口，请使用下载。", "error"); return }
    if (!popup) { onToast("浏览器阻止了新窗口，请允许弹出窗口或使用下载。", "error"); return }
    openedWindows.current.add(popup)
    let url: string | undefined
    try {
      popup.opener = null
      popup.document.title = "正在读取图片…"
      const blob = await fetchImage(generatedImage.url, epoch)
      if (!valid(epoch) || popup.closed) { popup.close(); openedWindows.current.delete(popup); return }
      url = makeUrl(blob)
      popup.location.replace(url)
      const release = url
      const timer = setTimeout(() => { releaseUrl(release); releaseTimers.current.delete(timer) }, 10_000)
      releaseTimers.current.add(timer)
    } catch (error) {
      popup.close()
      openedWindows.current.delete(popup)
      if (url) releaseUrl(url)
      if (valid(epoch)) onToast(error instanceof Error ? error.message : "图片打开失败。", "error")
    }
  }, [fetchImage, makeUrl, onToast, releaseUrl, valid])
  const copyImageToClipboard = useCallback(async (generatedImage: GeneratedImage | null) => {
    if (!generatedImage) return
    const epoch: Operation = { lifetime: lifetime.current, visibility: visibilityEpoch.current }
    let url: string | undefined
    try {
      let blob = await fetchImage(generatedImage.url, epoch)
      if (blob.type !== "image/png") {
        url = makeUrl(blob)
        const source = url
        blob = await new Promise<Blob>((resolve, reject) => {
          const image = new Image()
          image.onload = () => {
            if (!valid(epoch)) { reject(new Error("图片操作已取消。")); return }
            const canvas = document.createElement("canvas")
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
            const context = canvas.getContext("2d")
            if (!context) { reject(new Error("当前环境无法复制图片，请使用下载。")); return }
            context.drawImage(image, 0, 0)
            canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片转换失败。")), "image/png")
          }
          image.onerror = () => reject(new Error("图片读取失败。"))
          image.src = source
        })
      }
      if (!valid(epoch)) return
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
      if (valid(epoch)) onToast("图片已复制到剪贴板！", "success")
    } catch (error) { if (valid(epoch)) onToast(error instanceof Error ? error.message : "复制失败，请使用下载。", "error") }
    finally { if (url) releaseUrl(url) }
  }, [fetchImage, makeUrl, onToast, releaseUrl, valid])
  return { showFullscreen, fullscreenImageUrl, setFullscreenImageUrl, openFullscreen, closeFullscreen, downloadImage, downloadDocument, openImageInNewTab, copyImageToClipboard }
}
