import type { AnnotationSnapshot } from "./image-annotations"
import type { AnnotationExecution } from "./annotation-execution"
import type { ResolvedAnnotationCapability } from "./annotation-capability"
import type { ProviderSettings } from "./api-provider-types"
import type { PrivateRun, PrivateRunStatus } from "./private-workspace-types"

/** 仅服务端内部使用；字节保存在 COS，以下记录不得直接作为 API 响应。 */
export type PrivateAssetRecord = {
  id: string; ownerId: string; creationId: string; runId: string; key: string
  kind: "image" | "document"; mediaType: string; byteLength: number; sha256: string; name?: string
}
export type RunCommand = {
  creationId: string; clientRequestId: string; fingerprint: string; parentVersionId: string | null
  mappingId: string; configRevision: number; prompt: string; aspectRatio: string; quality: string
  mode: "text-to-image" | "image-editing"
  annotationSnapshot?: AnnotationSnapshot | null
}
export type PrivateRunRecord = {
  public: PrivateRun; ownerId: string; fingerprint: string; deadlineAt: number
  manifestKey: string; outputKey: string; outputAssetId: string
  annotationExecution: AnnotationExecution | null
  provider: { baseUrl: string; apiMode: ProviderSettings["apiMode"]; modelId: string; revision: number; annotationCapability?: ResolvedAnnotationCapability | null }
}
export type AcceptedPrivateRun = { acquired: boolean; record: PrivateRunRecord; settings?: ProviderSettings }
export type PrivateManifest = {
  schema: 1; ownerId: string; creationId: string; runId: string; fingerprint: string
  status: PrivateRunStatus; input: RunCommand; inputs: PrivateAssetRecord[]
  output: PrivateAssetRecord | null; baseInputId: string | null; createdAt: number; updatedAt: number
  effectivePrompt: string; provider: PrivateRunRecord["provider"]; annotationExecution?: AnnotationExecution | null
}
