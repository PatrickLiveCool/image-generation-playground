import { assertSameOrigin, accountErrorResponse, requireAccount } from "@/lib/auth/guards"
import { readJson } from "@/lib/auth/validation"
import { MAX_PROVIDER_JSON_BYTES, readAdminProvider, saveAdminProvider } from "@/lib/provider-configuration"

export async function GET(request: Request) {
  try { return Response.json(await readAdminProvider(request.headers), { headers: { "Cache-Control": "no-store" } }) }
  catch (error) { return accountErrorResponse(error) }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request)
    await requireAccount(request.headers, { admin: true })
    return Response.json(await saveAdminProvider(request.headers, await readJson(request, MAX_PROVIDER_JSON_BYTES)), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return accountErrorResponse(error) }
}
