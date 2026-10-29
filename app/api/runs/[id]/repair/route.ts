import { accountIdentity, assertSameOrigin } from "@/lib/auth/guards"
import { repairPrivateGeneration } from "@/lib/private-generation"
import { privateApiError, privateJson } from "@/lib/private-api"

export const maxDuration = 120
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request)
    const identity = await accountIdentity(request.headers)
    const run = await repairPrivateGeneration(identity, (await context.params).id)
    await accountIdentity(request.headers)
    return privateJson({ run }, run.status === "complete" ? 200 : 202)
  } catch (error) { return privateApiError(error) }
}
