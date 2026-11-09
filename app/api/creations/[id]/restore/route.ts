import { assertSameOrigin } from "@/lib/auth/guards"
import { readJson } from "@/lib/auth/validation"
import { restorePrivateCreation } from "@/lib/private-workspace-service"
import { privateApiError, privateJson } from "@/lib/private-api"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request)
    return privateJson({ creation: await restorePrivateCreation(request.headers, (await context.params).id, await readJson(request)) })
  } catch (error) { return privateApiError(error) }
}
