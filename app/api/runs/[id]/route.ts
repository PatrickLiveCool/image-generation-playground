import { accountIdentity } from "@/lib/auth/guards"
import { readPrivateRun } from "@/lib/private-workspace-service"
import { privateApiError, privateJson } from "@/lib/private-api"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await accountIdentity(request.headers)
    const record = await readPrivateRun(identity, (await context.params).id)
    return privateJson({ run: record.public })
  } catch (error) { return privateApiError(error) }
}
