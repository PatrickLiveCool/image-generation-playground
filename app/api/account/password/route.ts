import { changePassword } from "@/lib/auth/accounts"
import { accountErrorResponse, assertSameOrigin } from "@/lib/auth/guards"
import { readJson } from "@/lib/auth/validation"

export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    return Response.json(await changePassword(request.headers, await readJson(request)), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return accountErrorResponse(error) }
}
