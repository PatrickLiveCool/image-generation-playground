// Anonymous capability links belonged to the discarded demo. Account-owned
// assets are served by the new opaque-ID route after ownership validation.
// Keeping this explicit tombstone prevents a future generic proxy fallback.
export async function GET() {
  return new Response("旧版测试图片链接已停用。", {
    status: 410,
    headers: {
      "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
    },
  })
}
