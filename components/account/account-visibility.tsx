"use client"

import { createContext, useContext } from "react"

// Portals must obey the same account visibility boundary as their owning page.
export const AccountVisibilityContext = createContext(true)
export function useAccountVisible(): boolean {
  return useContext(AccountVisibilityContext)
}
