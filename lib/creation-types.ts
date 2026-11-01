import type { Generation, Quality } from "@/components/image-combiner/types"
import type { AnnotationDraft } from "./image-annotations"

export interface CreationDraft {
  prompt: string
  documentName?: string
  documentText?: string
  documentFile?: File | null
  documentImageInspection?: "none" | "present" | "unknown"
  annotationDrafts?: Record<string, AnnotationDraft>
  selectedMappingId: string
  aspectRatio: string
  quality: Quality
  useUrls: boolean
  image1: File | null
  image2: File | null
  image1Url: string
  image2Url: string
}

export type Draft = CreationDraft

export interface Creation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  selectedVersionId: string | null
  draft: CreationDraft
  versions: Generation[]
  unread: boolean
  draftRevision: number
  pendingDraftRevision: number | null
  remoteRevision?: number
  localOnly?: boolean
  creationUnknown?: boolean
}

export interface CreativeWorkspace {
  schema: 2
  revision: number
  lastWriteId?: string
  activeCreationId: string | null
  creations: Creation[]
}
