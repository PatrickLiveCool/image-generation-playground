"use client"

import { AccountGate } from "@/components/account/account-gate"
import { ImageCombiner } from "@/components/image-combiner"

export function AccountWorkspace() {
  return <AccountGate>{user => <ImageCombiner key={user.id} accountId={user.id} />}</AccountGate>
}
