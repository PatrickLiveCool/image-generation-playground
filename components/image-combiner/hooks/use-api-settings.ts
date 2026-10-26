"use client"

import { useCallback, useEffect, useState } from "react"
import {
  EMPTY_PROVIDER_SETTINGS,
  normalizeProviderSettings,
  validateProviderSettings,
  type ModelMapping,
  type ProviderModel,
  type ProviderSettings,
} from "@/lib/api-provider-types"

import { normalizeModelMappings, validateModelMappings, restoreModelMappings } from "@/lib/model-mappings"

const STORAGE_KEY = "image-playground-api-settings-v1"

interface SavedProvider {
  settings: ProviderSettings
  models: ProviderModel[]
  mappings: ModelMapping[]
  modelsSynced: boolean
}

function readSavedProvider(raw: string): SavedProvider | null {
  const saved: unknown = JSON.parse(raw)
  if (!saved || typeof saved !== "object" || !("settings" in saved)) return null
  const settings = saved.settings
  if (!settings || typeof settings !== "object") return null
  if (!("baseUrl" in settings) || typeof settings.baseUrl !== "string") return null
  if (!("apiKey" in settings) || typeof settings.apiKey !== "string") return null
  if (!("apiMode" in settings) || (settings.apiMode !== "images" && settings.apiMode !== "chat")) return null
  const normalized = normalizeProviderSettings(settings as ProviderSettings)
  if (validateProviderSettings(normalized)) return null
  const models = "models" in saved && Array.isArray(saved.models)
    ? saved.models.filter((model): model is ProviderModel => Boolean(
        model && typeof model === "object" && typeof model.id === "string" && model.id.trim(),
      )).map((model) => ({ id: model.id }))
    : []
  const mappings = restoreModelMappings("mappings" in saved ? saved.mappings : undefined)
  const modelsSynced = "modelsSynced" in saved ? saved.modelsSynced === true : models.length > 0
  return { settings: normalized, models, mappings, modelsSynced }
}

export function useApiSettings() {
  const [settings, setSettings] = useState<ProviderSettings>(EMPTY_PROVIDER_SETTINGS)
  const [models, setModels] = useState<ProviderModel[]>([])
  const [mappings, setMappings] = useState<ModelMapping[]>([])
  const [modelsSynced, setModelsSynced] = useState(false)
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY)
      const saved = raw ? readSavedProvider(raw) : null
      if (saved) {
        setSettings(saved.settings)
        setModels(saved.models)
        setMappings(saved.mappings)
        setModelsSynced(saved.modelsSynced)
      }
    } catch {
      setStorageError("浏览器无法恢复 API 配置，请重新填写。")
    } finally {
      setReady(true)
    }
  }, [])

  const saveSettings = useCallback((nextSettings: ProviderSettings, nextModels: ProviderModel[], nextMappings: ModelMapping[], nextModelsSynced: boolean) => {
    const normalized = normalizeProviderSettings(nextSettings)
    const normalizedMappings = normalizeModelMappings(nextMappings)
    const validationError = validateProviderSettings(normalized) || validateModelMappings(normalizedMappings)
    if (validationError) throw new Error(validationError)
    setSettings(normalized)
    setModels(nextModels)
    setMappings(normalizedMappings)
    setModelsSynced(nextModelsSynced)
    setStorageError(null)
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: normalized, models: nextModels, mappings: normalizedMappings, modelsSynced: nextModelsSynced }))
    } catch {
      setStorageError("浏览器不允许保存配置；本次页面可使用，刷新后需重新填写。")
    }
  }, [])

  const clearSettings = useCallback(() => {
    setSettings(EMPTY_PROVIDER_SETTINGS)
    setModels([])
    setMappings([])
    setModelsSynced(false)
    setStorageError(null)
    try {
      window.sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      setStorageError("浏览器未能清除保存的配置，请关闭此标签页。")
    }
  }, [])

  return {
    settings,
    models,
    mappings,
    modelsSynced,
    ready,
    isConfigured: validateProviderSettings(settings) === null,
    saveSettings,
    clearSettings,
    storageError,
  }
}
