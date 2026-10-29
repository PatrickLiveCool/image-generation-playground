import { accountErrorResponse, AccountError } from "./auth/errors"
import { ProviderError } from "./provider-network"
import { accountIdentity } from "./auth/guards"
import { createPrivateCosStore } from "./private-cos"
import { readPrivateAsset } from "./private-workspace-service"
import { readVerifiedPrivateAsset } from "./private-generation"

export function privateJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie" } })
}
export function privateApiError(error: unknown): Response {
  if (error instanceof ProviderError) return accountErrorResponse(new AccountError("PRIVATE_SERVICE_UNAVAILABLE", error.status, error.message))
  return accountErrorResponse(error)
}
export async function privateAssetResponse(request: Request, id: string, kind: "image" | "document"): Promise<Response> {
  try {
    const identity = await accountIdentity(request.headers)
    const asset = await readPrivateAsset(identity, id, kind)
    const { bytes, mediaType } = await readVerifiedPrivateAsset(asset, createPrivateCosStore())
    // COS读取期间若账号被禁用/会话撤销，响应前再次核对，不交出已读字节。
    await accountIdentity(request.headers)
    const encodedName = encodeURIComponent(asset.name ?? "document").replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": mediaType, "Content-Length": String(bytes.length), "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie",
      "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": kind === "document" ? `attachment; filename="document"; filename*=UTF-8''${encodedName}` : "inline",
    } })
  } catch (error) { return privateApiError(error) }
}
