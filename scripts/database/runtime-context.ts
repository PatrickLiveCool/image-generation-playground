import { fileURLToPath } from "node:url"
import path from "node:path"

// 只由构建器替换的常量；环境变量、命令行或备份内容不能改变迁移目录。
declare const __IMAGE_MAINTENANCE_BUNDLE__: boolean
export const MAINTENANCE_BUNDLED = typeof __IMAGE_MAINTENANCE_BUNDLE__ !== "undefined" && __IMAGE_MAINTENANCE_BUNDLE__
export const PROJECT_ROOT = fileURLToPath(new URL(MAINTENANCE_BUNDLED ? "../" : "../../", import.meta.url))
export const MIGRATIONS_ROOT = MAINTENANCE_BUNDLED
  ? fileURLToPath(new URL("./migrations/", import.meta.url))
  : path.join(PROJECT_ROOT, "migrations")
