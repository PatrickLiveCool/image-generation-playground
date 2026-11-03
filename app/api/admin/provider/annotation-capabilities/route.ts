import { assertSameOrigin, accountErrorResponse, requireAccount } from "@/lib/auth/guards"
import { AccountError } from "@/lib/auth/errors"

/** Old cached admin pages must not mutate the retired capability setting. */
async function retired(request: Request) {
  try {
    assertSameOrigin(request)
    await requireAccount(request.headers, { admin: true })
    throw new AccountError("ANNOTATION_CONFIGURATION_RETIRED", 410, "批注已默认可用，无需单独启用或停用。请刷新页面。")
  } catch (error) { return accountErrorResponse(error) }
}

export async function POST(request: Request) { return retired(request) }
export async function DELETE(request: Request) { return retired(request) }
