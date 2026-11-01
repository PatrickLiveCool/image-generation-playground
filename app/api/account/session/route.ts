import { AccountError, accountErrorResponse, requireAccount } from "@/lib/auth/guards"

export async function GET(request: Request) {
  try {
    const user = await requireAccount(request.headers, { allowPasswordChange: true })
    return Response.json({ user }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof AccountError && error.code === "UNAUTHENTICATED") return Response.json({ user: null }, { headers: { "Cache-Control": "no-store" } })
    return accountErrorResponse(error)
  }
}
