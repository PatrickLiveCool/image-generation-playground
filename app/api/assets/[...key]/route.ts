import { createCosStore, readCosConfig, validateAssetAccess } from "@/lib/cos-assets"
import { ProviderError } from "@/lib/provider-network"

const PRIVATE_IMAGE_HEADERS = {
  "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
}

export async function GET(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  try {
    const config = readCosConfig()
    const key = (await params).key.join("/")
    const query = new URL(request.url).searchParams
    if (query.size !== 1 || !validateAssetAccess(key, query.get("access"), config.assetAccessSecret)) {
      return new Response("图片访问凭据无效", { status: 403, headers: PRIVATE_IMAGE_HEADERS })
    }
    // Authorize before opening a COS client. Object bytes stay in request memory;
    // this route never creates files, cache entries or redirects to a second domain.
    const image = await createCosStore(config).getImage(key)
    return new Response(new Uint8Array(image.bytes), {
      status: 200,
      headers: {
        "Content-Type": image.mediaType, "Content-Length": String(image.bytes.length),
        ...PRIVATE_IMAGE_HEADERS,
      },
    })
  } catch (error) {
    return new Response("图片访问暂时不可用", { status: error instanceof ProviderError ? error.status : 503, headers: PRIVATE_IMAGE_HEADERS })
  }
}
