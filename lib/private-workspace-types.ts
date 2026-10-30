import type { AnnotationSnapshot } from "./image-annotations"
/** 浏览器可见的私有创作协议；不包含 ownerId、对象键、供应商地址或秘密。 */
export type PrivateRunStatus = "preparing" | "generating" | "saving" | "complete" | "failed" | "unknown" | "save_pending"
export type PrivateRun = {
  id: string; creationId: string; creationRevision: number; version: number; parentVersionId: string | null
  status: PrivateRunStatus; imageUrl: string | null; prompt: string
  annotationSnapshot: AnnotationSnapshot | null
  mappingId: string; modelLabel: string; aspectRatio: string; quality: string
  mode: "text-to-image" | "image-editing"; createdAt: number; updatedAt: number
  failureCode?: string; document?: { assetId: string; name: string }
}
export type PrivateCreation = {
  id: string; title: string; revision: number; createdAt: number; updatedAt: number; versions: PrivateRun[]
}
export type PrivateWorkspaceResponse = { creations: PrivateCreation[] }
