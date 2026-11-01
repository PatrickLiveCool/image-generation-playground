import { assertSameOrigin, accountErrorResponse, requireAccount } from "@/lib/auth/guards"
import { readJson } from "@/lib/auth/validation"
import { disableAdminAnnotationCapability, recordAdminAnnotationCapability } from "@/lib/provider-configuration"

export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    await requireAccount(request.headers, { admin: true })
    return Response.json(await recordAdminAnnotationCapability(request.headers, await readJson(request)), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return accountErrorResponse(error) }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request)
    await requireAccount(request.headers, { admin: true })
    return Response.json(await disableAdminAnnotationCapability(request.headers, await readJson(request)), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return accountErrorResponse(error) }
}
