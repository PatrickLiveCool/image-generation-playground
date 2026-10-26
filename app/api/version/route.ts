import { connection } from "next/server"
import { readReleaseIdentity } from "@/lib/release-identity"

export async function GET() {
  await connection()
  try {
    return Response.json({ ...readReleaseIdentity(), managed: true }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    if (process.env.NODE_ENV !== "production") {
      return Response.json({ application: "qintopia-image", version: "development", revision: null, managed: false }, { headers: { "Cache-Control": "no-store" } })
    }
    return Response.json({ application: "qintopia-image", error: "Verified release metadata is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
