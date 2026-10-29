import { lookup } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import type { ProviderSettings } from "./api-provider-types"

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_REQUEST_BYTES = 32 * 1024 * 1024

export class ProviderError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = "ProviderError"
    this.status = status
  }
}

function parsePublicHttpsUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw new ProviderError("请输入有效的 HTTPS 地址。")
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new ProviderError("地址格式不正确，请填写完整的 HTTPS 地址。")
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ProviderError("地址必须使用 HTTPS，且不能包含用户名、密码或片段。")
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!hostname.includes(".") && !isIP(hostname)) {
    throw new ProviderError("请使用公网 API 地址，不能连接本机或内网。")
  }
  if (/\.(?:localhost|local|internal|home|lan)\.?$/.test(hostname) || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new ProviderError("请使用公网 API 地址，不能连接本机或内网。")
  }
  return url
}

export function normalizeBaseUrl(value: unknown): string {
  const url = parsePublicHttpsUrl(value)
  if (url.search) throw new ProviderError("Base URL 不能包含查询参数，请填写 API 根地址。")
  return url.href.replace(/\/+$/, "")
}

export function validateProviderSettings(value: unknown): ProviderSettings {
  if (!value || typeof value !== "object") throw new ProviderError("请先配置 API 设置。")
  const settings = value as Record<string, unknown>
  const baseUrl = normalizeBaseUrl(settings.baseUrl)
  if (typeof settings.apiKey !== "string" || !settings.apiKey.trim() || settings.apiKey.length > 4096 || /[\r\n]/.test(settings.apiKey)) {
    throw new ProviderError("请输入有效的 API Token。")
  }
  const apiMode = settings.apiMode ?? "images"
  if (apiMode !== "images" && apiMode !== "chat") throw new ProviderError("请选择支持的 API 接口格式。")
  return { baseUrl, apiKey: settings.apiKey.trim(), apiMode }
}

/** Keep the user's exact API prefix. Never guess or append a version segment. */
export function endpointUrl(baseUrl: string, endpoint: string): string {
  if (!/^[a-z][a-z0-9/-]*$/i.test(endpoint) || endpoint.includes("..")) {
    throw new ProviderError("API 路径无效。")
  }
  return `${normalizeBaseUrl(baseUrl)}/${endpoint}`
}

/** Public unicast only, also rejecting IPv4-mapped IPv6 and transition ranges. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6) return false
  const [first, second = "0"] = address.toLowerCase().split(":")
  const a = parseInt(first, 16)
  const b = parseInt(second || "0", 16)
  // Only globally routed 2000::/3. Exclude special-purpose, documentation,
  // Teredo and 6to4 ranges so an embedded private IPv4 address cannot bypass this.
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3fff &&
    !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8))
}

async function resolvePublicHost(hostname: string, signal: AbortSignal) {
  const host = hostname.replace(/^\[|\]$/g, "")
  const literalFamily = isIP(host)
  if (literalFamily) {
    if (!isPublicAddress(host)) throw new ProviderError("不能连接本机、内网或保留地址。")
    return { address: host, family: literalFamily }
  }
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new ProviderError("API 地址解析到了内网或保留地址，无法连接。")
    }
    // Prefer IPv4 for hosts without usable IPv6 egress. The chosen address is
    // pinned below; the connection never performs a second DNS lookup.
    return addresses.find(({ family }) => family === 4) ?? addresses[0]
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

/** Bounded HTTPS request pinned to a checked public IP; redirects are rejected. */
export async function publicFetch(urlString: string, init: RequestInit = {}, maxResponseBytes = MAX_RESPONSE_BYTES): Promise<Response> {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new ProviderError("响应大小限制无效。")
  }
  const url = parsePublicHttpsUrl(urlString)
  const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(init.signal ? [init.signal] : [])])
  try {
    const address = await resolvePublicHost(url.hostname, AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
    signal.throwIfAborted()
    // Request handles multipart encoding (including its boundary) and all the
    // normal body types. No outgoing connection is made by this constructor.
    const prepared = new Request(url, { ...init, signal })
    const body = prepared.body ? Buffer.from(await prepared.arrayBuffer()) : undefined
    if (body && body.length > MAX_REQUEST_BYTES) throw new ProviderError("请求内容过大。")
    signal.throwIfAborted()
    const headers = Object.fromEntries(prepared.headers.entries())
    // Host and TLS identity stay the configured host, while the socket connects
    // directly to the validated address. Do not permit caller-controlled Host.
    headers.host = url.host
    headers["accept-encoding"] = "identity"
    delete headers.connection
    delete headers["transfer-encoding"]
    delete headers["content-length"]
    if (body) headers["content-length"] = String(body.length)

    return await new Promise<Response>((resolve, reject) => {
      const hostname = url.hostname.replace(/^\[|\]$/g, "")
      const request = httpsRequest({
        hostname: address.address,
        family: address.family,
        servername: isIP(hostname) ? undefined : hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: prepared.method,
        headers,
        agent: false,
        signal,
      }, (response) => {
        const status = response.statusCode ?? 502
        if (status < 200 || status > 599) {
          response.destroy()
          reject(new ProviderError("API 返回了不支持的响应状态。", 502))
          return
        }
        if (status >= 300 && status < 400) {
          response.destroy()
          reject(new ProviderError("API 返回了重定向，请填写最终的接口地址。", 502))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (size > maxResponseBytes) {
            response.destroy()
            reject(new ProviderError("API 返回内容超过允许的大小，请减少内容后重试。", 502))
            return
          }
          chunks.push(chunk)
        })
        response.on("error", reject)
        response.on("end", () => {
          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(key, entry))
            else if (value !== undefined) responseHeaders.set(key, value)
          }
          const bytes = Buffer.concat(chunks)
          resolve(new Response(status === 204 || status === 205 || status === 304 || prepared.method === "HEAD" ? null : bytes, {
            status,
            headers: responseHeaders,
          }))
        })
      })
      request.on("error", reject)
      request.end(body)
    })
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (init.signal?.aborted) throw new DOMException("请求已取消。", "AbortError")
    if (signal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
      throw new ProviderError("API 请求超时，请稍后重试。", 504)
    }
    // Never expose native request errors, which can contain URLs or credentials.
    throw new ProviderError("无法连接 API，请检查地址、网络及服务状态。", 502)
  }
}
