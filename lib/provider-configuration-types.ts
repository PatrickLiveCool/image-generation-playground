import type { ModelMapping, ProviderApiMode, ProviderModel, ProviderSettings } from "./api-provider-types"

export type AdminProviderConfiguration = {
  revision: number
  settings: ProviderSettings & { apiKey: "" }
  secretConfigured: boolean
  models: ProviderModel[]
  mappings: ModelMapping[]
  modelsSynced: boolean
}
export type PublicModelMapping = { id: string; name: string; aspectRatios: string[] }
export type PublicModelCatalog = { revision: number; configured: boolean; apiMode: ProviderApiMode; mappings: PublicModelMapping[] }
export type ProviderConfigurationInput = {
  revision: number; settings: ProviderSettings; models: ProviderModel[]; mappings: ModelMapping[]; modelsSynced: boolean
}
