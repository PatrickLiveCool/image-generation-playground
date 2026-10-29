import { createAccount, listAccounts } from "@/lib/auth/accounts"
import { accountErrorResponse, assertSameOrigin } from "@/lib/auth/guards"
import { readJson } from "@/lib/auth/validation"

export async function GET(request: Request) {
  try {
    return Response.json(await listAccounts(request.headers, new URL(request.url)), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return accountErrorResponse(error) }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    return Response.json(await createAccount(request.headers, await readJson(request)), { status: 201, headers: { "Cache-Control": "no-store" } })
  } catch (error) { return accountErrorResponse(error) }
}
