import COS from "cos-nodejs-sdk-v5"
import { createHash } from "node:crypto"
import { ProviderError } from "./provider-network"
import { MAX_IMAGE_BYTES } from "./relay-image"
import { MAX_DOCUMENT_BYTES } from "./document-context"

export const MAX_PRIVATE_MANIFEST_BYTES = 256 * 1024

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const UUID = new RegExp(`^${UUID_SOURCE}$`, "i")
const PRIVATE_KEY = new RegExp(`^image-playground/private/v1/[0-9a-f]{64}/${UUID_SOURCE}/${UUID_SOURCE}/(?:manifest\\.json|outputs/final|inputs/(?:reference-[12]|document-image-[12]|document))$`)

export interface PrivateCosStore {
  put(key: string, bytes: Uint8Array, mediaType: string): Promise<void>
  /** Returned mediaType is metadata only. Callers must verify image bytes and hashes. */
  get(key: string, maxBytes: number): Promise<{ bytes: Uint8Array; mediaType: string }>
}

interface PrivateCosClient {
  putObject(params: Record<string, unknown>, callback: (error: unknown, data?: unknown) => void): unknown
  getObject(params: Record<string, unknown>, callback: (error: unknown, data?: unknown) => void): unknown
}

export function privateRunPrefix(ownerId: string, creationId: string, runId: string): string {
  if (typeof ownerId !== "string" || !ownerId.trim() || /[\x00-\x1f\x7f]/.test(ownerId) ||
      typeof creationId !== "string" || creationId.length !== 36 || !UUID.test(creationId) ||
      typeof runId !== "string" || runId.length !== 36 || !UUID.test(runId)) {
    throw new ProviderError("私有对象归属或任务标识无效。", 400)
  }
  // Hash the exact authenticated identity, never a trimmed or case-folded value.
  const ownerHash = createHash("sha256").update(ownerId).digest("hex")
  return `image-playground/private/v1/${ownerHash}/${creationId.toLowerCase()}/${runId.toLowerCase()}`
}

/** Syntax validation only; authenticated ownership is checked by the workspace service. */
export function assertPrivateKey(key: string): void {
  if (typeof key !== "string" || key.trim() !== key || !PRIVATE_KEY.test(key)) throw new ProviderError("私有对象存储路径无效。", 400)
}

function keyLimit(key: string): number {
  assertPrivateKey(key)
  return key.endsWith("/manifest.json") ? MAX_PRIVATE_MANIFEST_BYTES : key.endsWith("/inputs/document") ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES
}

function validMediaType(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && !/[^\x20-\x7e]/.test(value) &&
    /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?: *;.+)?$/.test(value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function contentLength(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() === value && /^[1-9][0-9]*$/.test(value)) value = Number(value)
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function readBytes(data: unknown, maxBytes: number): { bytes: Uint8Array; mediaType: string } | undefined {
  const result = record(data)
  if (!result || !(result.Body instanceof Uint8Array) || !result.Body.byteLength || result.Body.byteLength > maxBytes ||
      (result.statusCode !== undefined && result.statusCode !== 200 && result.statusCode !== 206)) return
  const body = result.Body
  const headers = record(result.headers)
  const lengths = [result.ContentLength, headers?.["content-length"]].filter(value => value !== undefined)
  if (!lengths.length || lengths.some(value => contentLength(value) !== body.byteLength)) return
  const ranges = [result.ContentRange, headers?.["content-range"]].filter(value => value !== undefined)
  // Reject a partial object even if a server returned fewer bytes than the requested range.
  if (ranges.some(value => value !== `bytes 0-${body.byteLength - 1}/${body.byteLength}`)) return
  const type = result.ContentType ?? headers?.["content-type"] ?? "application/octet-stream"
  if (!validMediaType(type)) return
  return { bytes: Buffer.from(body), mediaType: type }
}

export function createPrivateCosStore(env: NodeJS.ProcessEnv = process.env, suppliedClient?: PrivateCosClient): PrivateCosStore {
  const required = ["COS_BUCKET", "COS_REGION", "COS_SECRET_ID", "COS_SECRET_KEY"] as const
  if (required.some(key => typeof env[key] !== "string" || !env[key]?.trim())) {
    throw new ProviderError("尚未配置私有对象存储，请完成 COS 配置。", 503)
  }
  const bucket = env.COS_BUCKET!
  const region = env.COS_REGION!
  if (bucket.trim() !== bucket || region.trim() !== region ||
      !/^[a-z0-9][a-z0-9-]*-\d+$/.test(bucket) || !/^[a-z]{2}-[a-z0-9-]+$/.test(region)) {
    throw new ProviderError("对象存储桶或地域配置无效。", 503)
  }
  let client: PrivateCosClient
  try {
    client = suppliedClient ?? new COS({
      SecretId: env.COS_SECRET_ID!, SecretKey: env.COS_SECRET_KEY!,
      Protocol: "https:", StrictSsl: true, FollowRedirect: false, AutoSwitchHost: false, Timeout: 60_000,
    }) as unknown as PrivateCosClient
  } catch { throw new ProviderError("私有对象存储服务初始化失败。", 503) }
  return {
    async put(key, bytes, mediaType) {
      const limit = keyLimit(key)
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > limit) {
        throw new ProviderError("私有对象存储文件大小无效。", 400)
      }
      if (!validMediaType(mediaType)) throw new ProviderError("私有对象存储文件类型无效。", 400)
      await new Promise<void>((resolve, reject) => {
        const failed = () => reject(new ProviderError("私有对象存储服务写入失败，请稍后重试。", 503))
        try {
          client.putObject({
            Bucket: bucket, Region: region, Key: key, Body: Buffer.from(bytes),
            ContentType: mediaType, ContentLength: bytes.byteLength, ACL: "private", CacheControl: "private, no-store",
          }, (error, data) => {
            try {
              const status = record(data)?.statusCode
              if (error || (status !== undefined && (typeof status !== "number" || status < 200 || status >= 300))) failed()
              else resolve()
            } catch { failed() }
          })
        } catch { failed() }
      })
    },
    async get(key, maxBytes) {
      const limit = keyLimit(key)
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > limit) {
        throw new ProviderError("私有对象读取大小限制无效。", 400)
      }
      return new Promise((resolve, reject) => {
        const failed = () => reject(new ProviderError("无法读取私有对象存储中的文件。", 502))
        try {
          // Inclusive end offset intentionally requests one extra byte to detect oversized objects.
          client.getObject({ Bucket: bucket, Region: region, Key: key, Range: `bytes=0-${maxBytes}` }, (error, data) => {
            try {
              const value = error ? undefined : readBytes(data, maxBytes)
              if (!value) failed()
              else resolve(value)
            } catch { failed() }
          })
        } catch { failed() }
      })
    },
  }
}
