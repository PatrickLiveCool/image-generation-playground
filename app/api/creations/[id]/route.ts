import { assertSameOrigin } from "@/lib/auth/guards"
import { readJson } from "@/lib/auth/validation"
import { readPrivateCreation, renamePrivateCreation } from "@/lib/private-workspace-service"
import { privateApiError, privateJson } from "@/lib/private-api"

type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  try { return privateJson({ creation: await readPrivateCreation(request.headers, (await context.params).id) }) }
  catch (error) { return privateApiError(error) }
}
export async function PATCH(request: Request, context: Context) {
  try {
    assertSameOrigin(request)
    return privateJson({ creation: await renamePrivateCreation(request.headers, (await context.params).id, await readJson(request)) })
  } catch (error) { return privateApiError(error) }
}
