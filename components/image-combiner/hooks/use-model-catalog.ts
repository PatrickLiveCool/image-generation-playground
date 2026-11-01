"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getPublicModelCatalog, providerConfigurationErrorMessage } from "@/lib/provider-configuration-client"
import type { PublicModelCatalog } from "@/lib/provider-configuration-types"

const EMPTY: PublicModelCatalog = { revision: 0, configured: false, apiMode: "images", mappings: [] }

/** Shared read-only catalog. Device tokens and local mappings never enter this path. */
export function useModelCatalog() {
  const [catalog, setCatalog] = useState<PublicModelCatalog>(EMPTY)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const id = ++sequence.current
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    try {
      const next = await getPublicModelCatalog(controller.signal)
      if (id !== sequence.current || controller.signal.aborted) return
      setCatalog(next)
      setError(null)
    } catch (error) {
      if (id !== sequence.current || controller.signal.aborted) return
      setError(providerConfigurationErrorMessage(error))
    } finally {
      if (id === sequence.current && !controller.signal.aborted) setReady(true)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener("focus", onFocus)
    return () => { ++sequence.current; pending.current?.abort(); window.removeEventListener("focus", onFocus) }
  }, [refresh])
  return { catalog, mappings: catalog.mappings, apiMode: catalog.apiMode, ready, error, refresh, isConfigured: ready && !error && catalog.configured }
}
