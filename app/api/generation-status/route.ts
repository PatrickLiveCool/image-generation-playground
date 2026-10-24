import { type NextRequest, NextResponse } from "next/server"
import { getRun } from "workflow/api"


export async function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("runId")

  if (!runId) {
    return NextResponse.json({ error: "缺少任务编号 runId" }, { status: 400 })
  }

  try {
    const run = getRun(runId)
    const status = await run.status

    if (status === "completed") {
      const result = await run.returnValue
      return NextResponse.json({
        status: "completed",
        result,
      })
    }

    if (status === "failed" || status === "cancelled") {
      return NextResponse.json({
        status: "failed",
        error: "生成失败",
      })
    }

    // pending or running — return startedAt so client can compute real progress
    const startedAt = await run.startedAt
    return NextResponse.json({
      status: "running",
      startedAt: startedAt?.toISOString() || null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误"
    console.error("[generation-status] Error getting run:", message, error)
    return NextResponse.json(
      { error: "查询生成状态失败", details: message },
      { status: 500 },
    )
  }
}
