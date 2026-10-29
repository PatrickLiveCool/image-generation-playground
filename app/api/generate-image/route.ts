import { requireAccount, assertSameOrigin, accountErrorResponse } from "@/lib/auth/guards"

export const maxDuration = 300

export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    await requireAccount(request.headers)
    // The old flow returns capability URLs that have been retired. Stop before
    // reading inputs or invoking a billable provider until the private flow lands.
    return Response.json({ error: { code: "PRIVATE_WORKSPACE_PENDING", message: "账号私有创作功能正在接入，当前阶段暂不能生成图片。" } }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    })
  } catch (error) { return accountErrorResponse(error) }
}
