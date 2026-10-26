import { NextResponse } from "next/server"
import { ProviderError, publicFetch, validateProviderSettings } from "@/lib/provider-network"
import { upstreamError } from "@/lib/relay-image"

export async function POST(request: Request) {
  try {
    const settings = validateProviderSettings(await request.json())
    const response = await publicFetch(`${settings.baseUrl}/models`, { headers: { Authorization: `Bearer ${settings.apiKey}` }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) })
    if (!response.ok) throw upstreamError(response.status)
    const data = await response.json()
    if (!Array.isArray(data?.data)) throw new ProviderError("中转未返回标准模型列表，可以手动填写模型 ID。", 502)
    const ids = [...new Set<string>(data.data.flatMap((model: any) => typeof model?.id === "string" && model.id.trim() && model.id.length <= 256 ? [model.id] : []))]
    return NextResponse.json({ models: ids.slice(0, 5000).sort().map(id => ({ id })) }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof ProviderError ? error.message : "无法读取模型列表，请检查地址和网络；也可以手动填写模型 ID。" }, { status: error instanceof ProviderError ? error.status : 502 })
  }
}
