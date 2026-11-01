import { accountIdentity, assertSameOrigin } from "@/lib/auth/guards"
import { privateApiError, privateJson } from "@/lib/private-api"
import { parsePrivateGenerationForm, readPrivateGenerationForm } from "@/lib/private-generation-input"
import { executePrivateGeneration } from "@/lib/private-generation"

export const maxDuration = 300

export async function POST(request: Request) {
  try {
    assertSameOrigin(request)
    const identity = await accountIdentity(request.headers)
    const input = await parsePrivateGenerationForm(await readPrivateGenerationForm(request))
    const run = await executePrivateGeneration(identity, input, AbortSignal.any([request.signal, AbortSignal.timeout(240_000)]))
    await accountIdentity(request.headers)
    return privateJson({ run }, run.status === "complete" ? 200 : 202)
  } catch (error) { return privateApiError(error) }
}
