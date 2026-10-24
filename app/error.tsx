'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Application error:', error)
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <h2 className="text-2xl font-bold text-foreground">出错了</h2>
        <p className="text-sm text-muted-foreground">
          发生了意外错误，请重试。
        </p>
        <Button onClick={() => reset()} className="w-full">
          重试
        </Button>
      </div>
    </div>
  )
}
