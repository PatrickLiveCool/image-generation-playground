import { assertSameOrigin, accountErrorResponse, requireAccount } from "@/lib/auth/guards"
import { readJson } from "@/lib/auth/validation"
import { MAX_PROVIDER_JSON_BYTES, syncAdminProvider } from "@/lib/provider-configuration"

export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    await requireAccount(request.headers, { admin: true })
    return Response.json(await syncAdminProvider(request.headers, await readJson(request, MAX_PROVIDER_JSON_BYTES), request.signal), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return accountErrorResponse(error) }
}
