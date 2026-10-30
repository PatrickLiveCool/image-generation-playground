import sharp from "sharp"
import { AccountError } from "./auth/errors"
import { imageBytes, type ImageBytes } from "./relay-image"
import type { ValidatedPrivateImage } from "./private-image-validation"
import { annotationDisplayBounds, orientedImageSize, toDisplayPoint, validateAnnotationSnapshot, type AnnotationSnapshot } from "./image-annotations"

const MAX_OVERLAY_BYTES = 10 * 1024 * 1024
/** 仅产生定位辅助图；不得用返回值替换原始基准。没有任何文件写入。 */
export async function renderAnnotationOverlay(original: ValidatedPrivateImage, value: AnnotationSnapshot): Promise<ImageBytes> {
  const snapshot = validateAnnotationSnapshot(value)
  const expected = snapshot.image
  if (original.pages !== 1 || original.width !== expected.width || original.height !== expected.height || original.orientation !== expected.orientation) {
    throw new AccountError("ANNOTATION_BASE_MISMATCH", 409, "批注与原始图片的尺寸或方向不一致，请重新载入基础版本。")
  }
  const { width, height } = orientedImageSize(expected)
  const stroke = Math.max(1, Math.min(8, Math.max(width, height) / 300))
  const radius = Math.max(6, Math.min(24, Math.min(width, height) / 24))
  const fragments: string[] = []
  for (const mark of snapshot.marks) {
    const bounds = annotationDisplayBounds(mark, expected), shape = mark.geometry
    const color = mark.number % 2 ? "#f97316" : "#06b6d4"
    if (shape.type === "rectangle") fragments.push('<rect x="' + bounds.x + '" y="' + bounds.y + '" width="' + bounds.width + '" height="' + bounds.height + '" fill="' + color + '" fill-opacity=".12" stroke="' + color + '" stroke-width="' + stroke + '"/>')
    else {
      const points = shape.points.map(point => toDisplayPoint(point, expected))
      const encoded = points.map(point => point.x + "," + point.y).join(" ")
      if (shape.type === "lasso") fragments.push('<polygon points="' + encoded + '" fill="' + color + '" fill-rule="evenodd" fill-opacity=".12" stroke="' + color + '" stroke-width="' + stroke + '"/>')
      else if (points.length === 1) fragments.push('<circle cx="' + points[0].x + '" cy="' + points[0].y + '" r="' + shape.brushWidth / 2 + '" fill="' + color + '" fill-opacity=".4"/>')
      else fragments.push('<polyline points="' + encoded + '" fill="none" stroke="' + color + '" stroke-width="' + shape.brushWidth + '" stroke-opacity=".4" stroke-linecap="round" stroke-linejoin="round"/>')
    }
    const x = Math.max(Math.min(radius, width / 2), Math.min(width - radius, bounds.x + radius))
    const y = Math.max(Math.min(radius, height / 2), Math.min(height - radius, bounds.y + radius))
    fragments.push('<circle cx="' + x + '" cy="' + y + '" r="' + radius + '" fill="#ffffff" stroke="' + color + '" stroke-width="' + stroke + '"/><text x="' + x + '" y="' + y + '" dominant-baseline="central" text-anchor="middle" font-family="sans-serif" font-size="' + radius * 1.15 + '" font-weight="700" fill="#111827">' + mark.number + '</text>')
  }
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' + fragments.join("") + "</svg>")
  try {
    const composed = sharp(Buffer.from(original.bytes), { limitInputPixels: 16_777_216, failOn: "error" }).autoOrient().composite([{ input: svg }])
    let bytes = await composed.clone().png().toBuffer()
    // 辅助图允许有损编码以保持现有输入预算；原图始终保持原字节和方向信息。
    if (bytes.length > MAX_OVERLAY_BYTES) bytes = await composed.clone().jpeg({ quality: 80 }).toBuffer()
    if (bytes.length > MAX_OVERLAY_BYTES) bytes = await composed.clone().jpeg({ quality: 65 }).toBuffer()
    if (bytes.length > MAX_OVERLAY_BYTES) throw new Error("overlay byte limit")
    return imageBytes(new Uint8Array(bytes))
  } catch {
    throw new AccountError("ANNOTATION_RENDER_FAILED", 400, "无法在图片输入限制内生成标注图，请缩小原图后重新标记。")
  }
}
