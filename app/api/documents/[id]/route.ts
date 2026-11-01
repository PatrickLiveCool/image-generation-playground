import { privateAssetResponse } from "@/lib/private-api"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return privateAssetResponse(request, (await context.params).id, "document")
}
