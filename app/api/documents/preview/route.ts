import { documentPreviewResponse } from "@/lib/document-preview"

export async function POST(request: Request) {
  return documentPreviewResponse(request)
}
