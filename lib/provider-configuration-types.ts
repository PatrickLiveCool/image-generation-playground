import type { ModelMapping, ProviderApiMode, ProviderModel, ProviderSettings } from "./api-provider-types"
import type { PublicAnnotationCapability, StoredAnnotationCapability } from "./annotation-capability"

export type AdminProviderConfiguration = {
  revision: number
  settings: ProviderSettings & { apiKey: "" }
  secretConfigured: boolean
  models: ProviderModel[]
  mappings: ModelMapping[]
  modelsSynced: boolean
  annotationCapabilities: StoredAnnotationCapability[]
}
export type PublicModelMapping = { id: string; name: string; aspectRatios: string[]; annotation: PublicAnnotationCapability }
export type PublicModelCatalog = { revision: number; configured: boolean; apiMode: ProviderApiMode; mappings: PublicModelMapping[] }
export type ProviderConfigurationInput = {
  revision: number; settings: ProviderSettings; models: ProviderModel[]; mappings: ModelMapping[]; modelsSynced: boolean
}
