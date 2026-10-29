import { assertSameOrigin } from "@/lib/auth/guards"
import { readJson } from "@/lib/auth/validation"
import { createPrivateCreation, listPrivateCreations } from "@/lib/private-workspace-service"
import { privateApiError, privateJson } from "@/lib/private-api"

export async function GET(request: Request) {
  try { return privateJson({ creations: await listPrivateCreations(request.headers) }) }
  catch (error) { return privateApiError(error) }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    return privateJson({ creation: await createPrivateCreation(request.headers, await readJson(request)) }, 201)
  } catch (error) { return privateApiError(error) }
}
