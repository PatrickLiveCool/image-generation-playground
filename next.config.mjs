/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // 保留 Node COS SDK 的独立模块边界，由 standalone 追踪并携带固定版本。
  serverExternalPackages: ["cos-nodejs-sdk-v5", "pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
  // PDF.js 以运行时相对路径加载 worker，必须显式随独立制品携带。
  outputFileTracingIncludes: {
    "/api/{documents/preview,generate-image}": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
  async headers() {
    return ["/", "/login", "/change-password", "/admin/:path*", "/api/account/:path*", "/api/admin/:path*", "/api/auth/:path*", "/api/creations/:path*", "/api/runs/:path*", "/api/images/:path*", "/api/documents/:path*", "/api/generate-image"].map(source => ({
      source,
      headers: [
        { key: "Cache-Control", value: "private, no-store" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    }))
  },

  cacheComponents: true,
  // 私有图片请求不得进入请求日志或磁盘缓存。
  logging: { incomingRequests: false },
  images: {
    unoptimized: true,
    qualities: [75, 85],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'generativelanguage.googleapis.com',
      },
      {
        protocol: 'https',
        hostname: '**.googleusercontent.com',
      },
      {
        protocol: 'https',
        hostname: '**.public.blob.vercel-storage.com',
      },
      {
        protocol: 'https',
        hostname: 'vercel.com',
      },
      {
        protocol: 'https',
        hostname: '**.vercel.com',
      },
    ],
  },
  experimental: {
    cpus: 1,
    optimizePackageImports: [
      'lucide-react',
      '@radix-ui/react-icons',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-popover',
      '@radix-ui/react-avatar',
      '@radix-ui/react-tooltip',
      '@radix-ui/react-progress',
      '@radix-ui/react-select',
      '@radix-ui/react-slot',
      'date-fns',
      'class-variance-authority',
      'swr',
    ],
  },
}

export default nextConfig
