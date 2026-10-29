import { accountErrorResponse } from "@/lib/auth/guards"
import { readPublicModelCatalog } from "@/lib/provider-configuration"

export async function GET(request: Request) {
  try { return Response.json(await readPublicModelCatalog(request.headers), { headers: { "Cache-Control": "no-store" } }) }
  catch (error) { return accountErrorResponse(error) }
}
