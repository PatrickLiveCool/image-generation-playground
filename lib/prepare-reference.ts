import { isHeicFile } from "./image-utils"

/** Preserve original pixels; only HEIC requires conversion for the image API. */
export async function prepareReference(file: File): Promise<File> {
  if (file.size > 10 * 1024 * 1024) throw new Error("单张参考图不能超过 10 MB。")
  if (!file.size) throw new Error("图片文件为空。")
  const heic = await isHeicFile(file) || /\.(heic|heif)$/i.test(file.name)
  if (heic) {
    try {
      let converted: Blob
      try {
        const heic2any = (await import("heic2any")).default
        const result = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.95 })
        converted = Array.isArray(result) ? result[0] : result
      } catch {
        const { heicTo } = await import("heic-to")
        converted = await heicTo({ blob: file, type: "image/jpeg", quality: 0.95 })
      }
      file = new File([converted], file.name.replace(/\.(heic|heif)$/i, ".jpg"), { type: "image/jpeg" })
    } catch { throw new Error("HEIC 图片转换失败，请改用 PNG、JPEG 或 WebP。") }
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("转换后的图片超过 10 MB，请使用较小的参考图。")
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const mime = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : String.fromCharCode(...bytes.slice(0, 3)) === "GIF" ? "image/gif"
    : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP" ? "image/webp" : null
  if (!mime) throw new Error("请选择 PNG、JPEG、WebP、GIF 或 HEIC 图片。")
  return file.type === mime ? file : new File([file], file.name, { type: mime, lastModified: file.lastModified })
}
