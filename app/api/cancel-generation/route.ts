import { type NextRequest, NextResponse } from "next/server"
import { getRun } from "workflow/api"

export async function POST(request: NextRequest) {
  try {
    const { runId } = await request.json()

    if (!runId) {
      return NextResponse.json({ error: "缺少任务编号 runId" }, { status: 400 })
    }

    const run = getRun(runId)
    await run.cancel()

    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误"
    console.error("[cancel-generation] Error:", message)
    // Don't fail — the workflow might already be done
    return NextResponse.json({ success: true })
  }
}
