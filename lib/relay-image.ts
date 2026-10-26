import type { ProviderSettings } from "./api-provider-types"
import { ProviderError, publicFetch } from "./provider-network"

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export type ImageBytes = { bytes: Uint8Array; mediaType: string }
const RATIOS: Record<string, string> = {
  square: "1:1", portrait: "9:16", landscape: "16:9", wide: "21:9",
  "4:3": "4:3", "3:4": "3:4", "3:2": "3:2", "2:3": "2:3", "5:4": "5:4", "4:5": "4:5",
}

// Keep the Images request aligned with the complete aspect-ratio vocabulary.
// Providers remain responsible for rejecting sizes their selected model cannot produce.
const SIZES: Record<string, string> = {
  square: "1024x1024", portrait: "1024x1792", landscape: "1792x1024", wide: "2048x864",
  "4:3": "1024x768", "3:4": "768x1024", "3:2": "1536x1024", "2:3": "1024x1536",
  "5:4": "1280x1024", "4:5": "1024x1280",
}

export function imageBytes(bytes: Uint8Array): ImageBytes {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ProviderError("图片为空或超过 20 MB。", 400)
  const b = Buffer.from(bytes)
  const mediaType = b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
    : b[0] === 255 && b[1] === 216 && b[2] === 255 ? "image/jpeg"
    : /^GIF8[79]a/.test(b.subarray(0, 6).toString()) ? "image/gif"
    : b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null
  if (!mediaType) throw new ProviderError("接口未返回支持的图片格式（PNG、JPG、WebP、GIF）。", 502)
  return { bytes, mediaType }
}

function fromBase64(value: string): ImageBytes {
  if (value.length > MAX_IMAGE_BYTES * 1.4 || !/^[A-Za-z0-9+/\s]+={0,2}$/.test(value)) {
    throw new ProviderError("接口返回的图片数据无效或过大。", 502)
  }
  return imageBytes(Buffer.from(value, "base64"))
}

export async function readImageSource(source: string, signal?: AbortSignal): Promise<ImageBytes> {
  if (source.startsWith("data:")) {
    const match = source.match(/^data:image\/(?:png|jpe?g|webp|gif);base64,([\s\S]+)$/)
    if (!match) throw new ProviderError("图片数据格式不受支持。", 400)
    return fromBase64(match[1])
  }
  // A generated image URL can point to a different CDN. Never forward the API token.
  const response = await publicFetch(source, { signal })
  if (!response.ok) throw new ProviderError("无法下载接口返回的图片，请重试。", 502)
  return imageBytes(new Uint8Array(await response.arrayBuffer()))
}

export function upstreamError(status: number): ProviderError {
  const message = status === 401 || status === 403 ? "中转拒绝访问，请检查 Token 和模型权限。"
    : status === 404 ? "中转未找到接口或模型，请检查 Base URL、接口类型和模型 ID。"
    : status === 429 ? "中转限流或额度不足，请稍后重试并检查账户额度。"
    : status === 400 || status === 422 ? "中转不接受当前参数，请检查模型、接口类型、图片尺寸或参考图支持情况。"
    : `中转请求失败（HTTP ${status}），请检查服务状态。`
  return new ProviderError(message, status === 429 ? 429 : 502)
}

// Parse common Images and Chat Completions response shapes without inferring a model provider.
export function extractImageSource(data: any): { source: string; description: string } {
  const first = data?.data?.[0]
  if (typeof first?.b64_json === "string") return { source: `data:image/png;base64,${first.b64_json}`, description: "" }
  if (typeof first?.url === "string") return { source: first.url, description: "" }
  const message = data?.choices?.[0]?.message
  for (const part of [...(Array.isArray(message?.images) ? message.images : []), ...(Array.isArray(message?.content) ? message.content : [])]) {
    const source = typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url
    if (typeof source === "string") return { source, description: "" }
    if (part?.type === "text" && typeof part.text === "string") {
      const match = part.text.match(/!\[[^\]]*\]\((https:\/\/[^\s)]+|data:image\/[^\s)]+)\)/)
      if (match) return { source: match[1], description: "" }
    }
  }
  if (typeof message?.content === "string") {
    const markdown = message.content.match(/!\[[^\]]*\]\((https:\/\/[^\s)]+|data:image\/[^\s)]+)\)/)
    const direct = message.content.trim()
    const source = markdown?.[1] ?? (direct.startsWith("data:image/") ? direct : null)
    if (source) return { source, description: "" }
  }
  throw new ProviderError("接口未返回图片。请确认该模型支持生图，并选择正确的接口类型。", 502)
}

export async function generateRelayImage(settings: ProviderSettings, input: {
  model: string; prompt: string; aspectRatio: string; quality: string; images: ImageBytes[]
}, signal?: AbortSignal, send: typeof publicFetch = publicFetch): Promise<ImageBytes> {
  const headers: Record<string, string> = { Authorization: `Bearer ${settings.apiKey}` }
  let path: string
  let body: string | FormData
  if (settings.apiMode === "chat") {
    path = "/chat/completions"
    headers["Content-Type"] = "application/json"
    const content = [
      { type: "text", text: `${input.prompt}\n\n请生成图片，期望宽高比：${RATIOS[input.aspectRatio] ?? input.aspectRatio}。` },
      ...input.images.map(image => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}` } })),
    ]
    body = JSON.stringify({ model: input.model, messages: [{ role: "user", content }], modalities: ["image", "text"], stream: false })
  } else {
    const size = SIZES[input.aspectRatio]
    if (!size) throw new ProviderError("当前宽高比参数无效，请重新选择。", 400)
    const fields = { model: input.model, prompt: input.prompt, n: 1, size, ...(input.quality !== "auto" ? { quality: input.quality } : {}) }
    if (input.images.length) {
      path = "/images/edits"
      const form = new FormData()
      Object.entries(fields).forEach(([key, value]) => form.append(key, String(value)))
      input.images.forEach((image, index) => form.append(input.images.length === 1 ? "image" : "image[]", new Blob([new Uint8Array(image.bytes)], { type: image.mediaType }), `reference-${index + 1}.${image.mediaType.split("/")[1]}`))
      body = form
    } else {
      path = "/images/generations"
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(fields)
    }
  }
  const response = await send(`${settings.baseUrl}${path}`, { method: "POST", headers, body, signal })
  if (!response.ok) throw upstreamError(response.status)
  let data: unknown
  try { data = await response.json() } catch { throw new ProviderError("中转未返回有效 JSON，请检查 Base URL 和接口类型。", 502) }
  const { source } = extractImageSource(data)
  return readImageSource(source, signal)
}
