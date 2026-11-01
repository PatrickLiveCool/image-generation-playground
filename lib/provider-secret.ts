import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { AccountError } from "./auth/errors"

if (typeof window !== "undefined") throw new Error("模型配置秘密只能在服务端使用。")

// 绑定唯一配置行、字段职责和格式版本，密文不能挪作其他秘密使用。
const AAD = Buffer.from("qintopia-image:app.provider_settings:1:apiKey:v1", "utf8")
const failure = () => new AccountError("PROVIDER_SECRET_UNAVAILABLE", 503, "模型配置密钥缺失或配置无法解密，请联系管理员。")

function strictBase64(value: unknown, bytes?: number): Buffer {
  if (typeof value !== "string" || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw failure()
  const decoded = Buffer.from(value, "base64")
  if (decoded.toString("base64") !== value || (bytes !== undefined && decoded.length !== bytes)) throw failure()
  return decoded
}

type ProviderSecretEnvironment = Partial<NodeJS.ProcessEnv>

export function providerConfigurationKey(environment: ProviderSecretEnvironment = process.env): Buffer {
  return strictBase64(environment.PROVIDER_CONFIG_KEY, 32)
}

export function encryptProviderSecret(secret: string, environment: ProviderSecretEnvironment = process.env): string {
  if (!secret || secret.length > 4096 || /[\r\n]/.test(secret)) throw failure()
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", providerConfigurationKey(environment), nonce)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()])
  return JSON.stringify({ version: 1, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") })
}

export function decryptProviderSecret(envelope: unknown, environment: ProviderSecretEnvironment = process.env): string {
  try {
    const key = providerConfigurationKey(environment)
    if (typeof envelope !== "string" || envelope.length > 24_000) throw failure()
    const value: unknown = JSON.parse(envelope)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failure()
    const record = value as Record<string, unknown>
    if (Object.keys(record).sort().join(",") !== "ciphertext,nonce,tag,version" || record.version !== 1) throw failure()
    const decipher = createDecipheriv("aes-256-gcm", key, strictBase64(record.nonce, 12))
    decipher.setAAD(AAD)
    decipher.setAuthTag(strictBase64(record.tag, 16))
    const plain = Buffer.concat([decipher.update(strictBase64(record.ciphertext)), decipher.final()])
    const secret = new TextDecoder("utf-8", { fatal: true }).decode(plain)
    if (!secret || secret.length > 4096 || /[\r\n]/.test(secret)) throw failure()
    return secret
  } catch { throw failure() }
}
