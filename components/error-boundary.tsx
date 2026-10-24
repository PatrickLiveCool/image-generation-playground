"use client"

import { Component, type ReactNode } from "react"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error("Error caught by boundary:", error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="min-h-screen bg-black text-white flex items-center justify-center p-4">
            <div className="text-center max-w-md">
              <h2 className="text-2xl font-bold mb-4">出错了</h2>
              <p className="text-gray-400 mb-6">发生了意外错误，请刷新页面后重试。</p>
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-2 bg-white text-black rounded hover:bg-gray-200 transition-colors"
              >
                刷新页面
              </button>
            </div>
          </div>
        )
      )
    }

    return this.props.children
  }
}
