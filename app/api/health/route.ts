import { connection } from "next/server"
import { readCosConfig } from "@/lib/cos-assets"
import { readReleaseIdentity } from "@/lib/release-identity"

/** Readiness checks local configuration only; it never invokes a model or writes a COS object. */
export async function GET() {
  await connection()
  try {
    const identity = readReleaseIdentity()
    readCosConfig()
    return Response.json({ status: "ready", application: identity.application, version: identity.version, revision: identity.revision }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ status: "not-ready", application: "qintopia-image" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
