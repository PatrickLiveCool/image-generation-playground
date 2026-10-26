import COS from "cos-nodejs-sdk-v5"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { ProviderError } from "./provider-network"
import { imageBytes, MAX_IMAGE_BYTES, type ImageBytes } from "./relay-image"

export interface CosConfig {
  bucket: string
  region: string
  secretId: string
  secretKey: string
  domain: string
  cdnAuthKey: string
  assetAccessSecret: string
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const IMAGE_KEY = new RegExp(`^image-playground/runs/${UUID}/(?:inputs/reference-[12]|outputs/final)\\.(?:png|jpg|webp|gif)$`)
const MANIFEST_KEY = new RegExp(`^image-playground/runs/${UUID}/manifest\\.json$`)
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }

export function readCosConfig(env: NodeJS.ProcessEnv = process.env): CosConfig {
  const required = ["COS_BUCKET", "COS_REGION", "COS_SECRET_ID", "COS_SECRET_KEY", "COS_DOMAIN", "CDN_AUTH_KEY", "ASSET_ACCESS_SECRET"] as const
  if (required.some(key => !env[key]?.trim())) throw new ProviderError("尚未配置对象存储，无法生成图片。请完成 COS 和图片域名配置。", 503)
  let domain: URL
  try { domain = new URL(env.COS_DOMAIN!) } catch { throw new ProviderError("图片域名配置无效，请检查 COS_DOMAIN。", 503) }
  if (domain.protocol !== "https:" || domain.username || domain.password || domain.search || domain.hash || !["", "/"].includes(domain.pathname)) {
    throw new ProviderError("图片域名配置无效，请检查 COS_DOMAIN。", 503)
  }
  if (!/^[a-z0-9][a-z0-9-]*-\d+$/.test(env.COS_BUCKET!) || !/^[a-z]{2}-[a-z0-9-]+$/.test(env.COS_REGION!)) {
    throw new ProviderError("对象存储桶或地域配置无效。", 503)
  }
  if (env.ASSET_ACCESS_SECRET!.length < 32 || env.CDN_AUTH_KEY!.length < 16) {
    throw new ProviderError("图片访问密钥配置无效。", 503)
  }
  return {
    bucket: env.COS_BUCKET!, region: env.COS_REGION!, secretId: env.COS_SECRET_ID!, secretKey: env.COS_SECRET_KEY!,
    domain: domain.origin, cdnAuthKey: env.CDN_AUTH_KEY!, assetAccessSecret: env.ASSET_ACCESS_SECRET!,
  }
}

export function isAssetImageKey(key: string): boolean { return IMAGE_KEY.test(key) }
export function imageExtension(mediaType: string): string {
  const extension = EXTENSIONS[mediaType]
  if (!extension) throw new ProviderError("图片格式不受支持。", 400)
  return extension
}

function accessToken(key: string, secret: string): string {
  return createHmac("sha256", secret).update(`image-playground:asset:v1\0${key}`).digest("base64url")
}

export function validateAssetAccess(key: string, token: string | null, secret: string): boolean {
  if (!isAssetImageKey(key) || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false
  const actual = Buffer.from(token, "base64url")
  const expected = Buffer.from(accessToken(key, secret), "base64url")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function stableAssetUrl(key: string, config: CosConfig): string {
  if (!isAssetImageKey(key)) throw new ProviderError("图片对象路径无效。", 400)
  return `/api/assets/${key}?access=${accessToken(key, config.assetAccessSecret)}`
}

/** Tencent CDN Type D: md5(secret + pathname + decimal timestamp), t/sign query fields.
 * The domain's CDN authentication rule enforces the 900 second validity window. */
export function signedCdnUrl(key: string, config: CosConfig, nowMs = Date.now()): string {
  if (!isAssetImageKey(key)) throw new ProviderError("图片对象路径无效。", 400)
  const pathname = `/${key}`
  const timestamp = String(Math.floor(nowMs / 1000))
  const sign = createHash("md5").update(`${config.cdnAuthKey}${pathname}${timestamp}`).digest("hex")
  const url = new URL(pathname, config.domain)
  url.searchParams.set("t", timestamp)
  url.searchParams.set("sign", sign)
  return url.toString()
}

export interface CosStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  getImage(key: string): Promise<ImageBytes>
  assetUrl(key: string): string
  config: CosConfig
}

interface CosClient {
  putObject(params: Record<string, unknown>, callback: (error: unknown, data: unknown) => void): unknown
  getObject(params: Record<string, unknown>, callback: (error: unknown, data: { Body?: unknown } | undefined) => void): unknown
}

export function createCosStore(config = readCosConfig(), suppliedClient?: CosClient): CosStore {
  const client = suppliedClient ?? new COS({ SecretId: config.secretId, SecretKey: config.secretKey, Protocol: "https:", Timeout: 60_000 }) as unknown as CosClient
  return {
    config,
    assetUrl: key => stableAssetUrl(key, config),
    async put(key, bytes, contentType) {
      if (!isAssetImageKey(key) && !MANIFEST_KEY.test(key)) throw new ProviderError("对象存储路径无效。", 400)
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ProviderError("对象存储文件大小无效。", 400)
      await new Promise<void>((resolve, reject) => {
        const failed = () => reject(new ProviderError("图片存储服务写入失败，请稍后重试。", 503))
        try {
          client.putObject({
            Bucket: config.bucket, Region: config.region, Key: key,
            Body: Buffer.from(bytes), ContentType: contentType, ContentLength: bytes.length,
            ACL: "private", CacheControl: contentType === "application/json" ? "no-store" : "private, max-age=900",
          }, error => error ? failed() : resolve())
        } catch { failed() }
      })
    },
    async getImage(key) {
      if (!isAssetImageKey(key)) throw new ProviderError("图片对象路径无效。", 403)
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        const failed = () => reject(new ProviderError("无法读取对象存储中的图片。", 502))
        try {
          client.getObject({ Bucket: config.bucket, Region: config.region, Key: key, Range: `bytes=0-${MAX_IMAGE_BYTES}` }, (error, data) => {
            if (error || !Buffer.isBuffer(data?.Body)) { failed(); return }
            resolve(data.Body)
          })
        } catch { failed() }
      })
      return imageBytes(bytes)
    },
  }
}

/** Recognize only our relative capability URL. Unowned image URLs use the public URL validator. */
export async function readOwnedAsset(source: string, store: CosStore): Promise<ImageBytes | null> {
  if (!source.startsWith("/api/assets/")) return null
  const url = new URL(source, "https://local.invalid")
  const key = url.pathname.slice("/api/assets/".length)
  if (url.hash || url.searchParams.size !== 1 || !validateAssetAccess(key, url.searchParams.get("access"), store.config.assetAccessSecret)) {
    throw new ProviderError("图片访问凭据无效，请重新选择参考图。", 403)
  }
  return store.getImage(key)
}
