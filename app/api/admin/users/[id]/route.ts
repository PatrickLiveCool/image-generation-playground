import { manageAccount } from "@/lib/auth/accounts"
import { accountErrorResponse, assertSameOrigin } from "@/lib/auth/guards"
import { readJson } from "@/lib/auth/validation"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request)
    return Response.json(await manageAccount(request.headers, (await context.params).id, await readJson(request)), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return accountErrorResponse(error) }
}
