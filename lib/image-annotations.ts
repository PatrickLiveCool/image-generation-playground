/** 浏览器与服务端共同使用的批注几何协议；不依赖图片解码或账户环境。 */
export const MAX_ANNOTATION_MARKS = 20
export const MAX_ANNOTATION_PATH_POINTS = 256
export const MAX_ANNOTATION_TOTAL_POINTS = 4096
export const MAX_ANNOTATION_INSTRUCTION_CHARS = 500
export const MAX_ANNOTATION_SNAPSHOT_BYTES = 128 * 1024
export const MAX_ANNOTATION_IMAGE_PIXELS = 16_777_216
export const ANNOTATION_RENDER_VERSION = 1 as const
export type AnnotationPoint = { x: number; y: number }
export type AnnotationImageMetadata = { assetId: string; width: number; height: number; orientation: number; pages: number }
export type AnnotationImage = AnnotationImageMetadata & { pages: 1 }
export type AnnotationGeometry =
  | { type: "rectangle"; x: number; y: number; width: number; height: number }
  | { type: "lasso"; points: AnnotationPoint[] }
  | { type: "brush"; points: AnnotationPoint[]; brushWidth: number }
export type AnnotationMark = { id: string; number: number; instruction: string; geometry: AnnotationGeometry }
export type AnnotationSnapshot = { schema: 1; coordinateSpace: "encoded-pixels-v1"; baseVersionId: string; image: AnnotationImage; marks: AnnotationMark[] }
export type AnnotationDraft = { snapshot: AnnotationSnapshot; revision: number; nextNumber: number }
export type AnnotationBounds = { x: number; y: number; width: number; height: number }

export class AnnotationValidationError extends Error {
  constructor(message: string) { super(message); this.name = "AnnotationValidationError" }
}
const fail = (message: string): never => { throw new AnnotationValidationError(message) }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("批注数据格式无效。")
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== fields.length || fields.some(field => !Object.hasOwn(result, field))) return fail("批注包含缺失或不支持的字段。")
  return result
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return fail("批注或基础版本标识无效。")
  return value.toLowerCase()
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return fail("批注尺寸、方向或编号无效。")
  return value
}
function coordinate(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) return fail("批注坐标必须位于原图范围内。")
  return Math.round(value * 100) / 100
}
export function validateAnnotationSnapshot(value: unknown, options: { allowIncomplete?: boolean } = {}): AnnotationSnapshot {
  let bytes: number
  try { bytes = new TextEncoder().encode(JSON.stringify(value)).length } catch { return fail("批注数据无法读取。") }
  if (bytes > MAX_ANNOTATION_SNAPSHOT_BYTES) return fail("批注数据超过128 KiB，请减少路径点数。")
  const root = record(value, ["schema", "coordinateSpace", "baseVersionId", "image", "marks"])
  if (root.schema !== 1 || root.coordinateSpace !== "encoded-pixels-v1") return fail("批注版本不受支持，请保留原草稿。")
  const rawImage = record(root.image, ["assetId", "width", "height", "orientation", "pages"])
  const image: AnnotationImage = { assetId: uuid(rawImage.assetId), width: integer(rawImage.width, 1, 16384),
    height: integer(rawImage.height, 1, 16384), orientation: integer(rawImage.orientation, 1, 8), pages: 1 }
  if (rawImage.pages !== 1 || image.width * image.height > MAX_ANNOTATION_IMAGE_PIXELS) return fail("批注仅支持约1600万像素以内的单帧原图。")
  if (!Array.isArray(root.marks) || root.marks.length > MAX_ANNOTATION_MARKS || (!options.allowIncomplete && !root.marks.length)) return fail("请添加1至20条区域批注。")
  const ids = new Set<string>(), numbers = new Set<number>()
  let pointCount = 0
  const marks = root.marks.map((value): AnnotationMark => {
    const item = record(value, ["id", "number", "instruction", "geometry"])
    const id = uuid(item.id), number = integer(item.number, 1, 1_000_000)
    if (ids.has(id) || numbers.has(number)) return fail("批注标识或编号重复。")
    ids.add(id); numbers.add(number)
    if (typeof item.instruction !== "string" || item.instruction.length > MAX_ANNOTATION_INSTRUCTION_CHARS ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.instruction)) return fail("每条批注说明最多500字，且不能包含控制字符。")
    const entered = item.instruction.replace(/\r\n?/g, "\n")
    const instruction = options.allowIncomplete ? entered : entered.trim()
    if (!options.allowIncomplete && !instruction) return fail("请为每个标记填写修改说明。")
    const kind = (item.geometry as { type?: unknown } | null)?.type
    let geometry: AnnotationGeometry
    if (kind === "rectangle") {
      const source = record(item.geometry, ["type", "x", "y", "width", "height"])
      const x = coordinate(source.x, image.width), y = coordinate(source.y, image.height)
      const width = coordinate(source.width, image.width), height = coordinate(source.height, image.height)
      if (width <= 0 || height <= 0 || x + width > image.width || y + height > image.height) return fail("矩形区域必须有面积且位于原图内。")
      geometry = { type: "rectangle", x, y, width, height }
    } else if (kind === "lasso" || kind === "brush") {
      const source = record(item.geometry, kind === "lasso" ? ["type", "points"] : ["type", "points", "brushWidth"])
      if (!Array.isArray(source.points) || source.points.length < (kind === "lasso" ? 3 : 1) || source.points.length > MAX_ANNOTATION_PATH_POINTS) return fail("每条路径需有效的点，且不能超过256点。")
      pointCount += source.points.length
      if (pointCount > MAX_ANNOTATION_TOTAL_POINTS) return fail("所有批注路径合计不能超过4096点。")
      const points = source.points.map(value => {
        const point = record(value, ["x", "y"])
        return { x: coordinate(point.x, image.width), y: coordinate(point.y, image.height) }
      })
      if (kind === "lasso") {
        const distinct = new Set(points.map(point => point.x + "," + point.y))
        const bounds = pointsBounds(points)
        const first = points[0], second = points.find(point => point.x !== first.x || point.y !== first.y)
        if (distinct.size < 3 || !bounds.width || !bounds.height || !second ||
          !points.some(point => Math.abs((second.x - first.x) * (point.y - first.y) - (second.y - first.y) * (point.x - first.x)) > 0.00001)) return fail("自由圈选需要形成有效区域。")
        geometry = { type: "lasso", points }
      } else {
        const brushWidth = coordinate(source.brushWidth, Math.max(image.width, image.height))
        if (brushWidth <= 0) return fail("笔刷宽度必须大于0。")
        geometry = { type: "brush", points, brushWidth }
      }
    } else return fail("仅支持矩形、自由圈选和涂抹。")
    return { id, number, instruction, geometry }
  }).sort((a, b) => a.number - b.number)
  return { schema: 1, coordinateSpace: "encoded-pixels-v1", baseVersionId: uuid(root.baseVersionId), image, marks }
}
export function serializeAnnotationSnapshot(snapshot: AnnotationSnapshot): string {
  return JSON.stringify(validateAnnotationSnapshot(snapshot, { allowIncomplete: true }))
}
export function createEmptyAnnotationSnapshot(baseVersionId: string, image: AnnotationImageMetadata): AnnotationSnapshot {
  return validateAnnotationSnapshot({ schema: 1, coordinateSpace: "encoded-pixels-v1", baseVersionId, image, marks: [] }, { allowIncomplete: true })
}
type ImageTransform = Pick<AnnotationImageMetadata, "width" | "height" | "orientation">
export function orientedImageSize(image: ImageTransform): { width: number; height: number } {
  return image.orientation >= 5 ? { width: image.height, height: image.width } : { width: image.width, height: image.height }
}
export function toDisplayPoint(point: AnnotationPoint, image: ImageTransform): AnnotationPoint {
  const { x, y } = point, { width: w, height: h } = image
  switch (image.orientation) {
    case 2: return { x: w - x, y }
    case 3: return { x: w - x, y: h - y }
    case 4: return { x, y: h - y }
    case 5: return { x: y, y: x }
    case 6: return { x: h - y, y: x }
    case 7: return { x: h - y, y: w - x }
    case 8: return { x: y, y: w - x }
    default: return { x, y }
  }
}
export function toEncodedPoint(point: AnnotationPoint, image: ImageTransform): AnnotationPoint {
  const { x, y } = point, { width: w, height: h } = image
  switch (image.orientation) {
    case 2: return { x: w - x, y }
    case 3: return { x: w - x, y: h - y }
    case 4: return { x, y: h - y }
    case 5: return { x: y, y: x }
    case 6: return { x: y, y: h - x }
    case 7: return { x: w - y, y: h - x }
    case 8: return { x: w - y, y: x }
    default: return { x, y }
  }
}
function pointsBounds(points: AnnotationPoint[]): AnnotationBounds {
  const xs = points.map(point => point.x), ys = points.map(point => point.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}
export function annotationMarkBounds(mark: AnnotationMark): AnnotationBounds {
  const shape = mark.geometry
  if (shape.type === "rectangle") return { x: shape.x, y: shape.y, width: shape.width, height: shape.height }
  const bounds = pointsBounds(shape.points)
  return shape.type === "brush" ? { x: bounds.x - shape.brushWidth / 2, y: bounds.y - shape.brushWidth / 2,
    width: bounds.width + shape.brushWidth, height: bounds.height + shape.brushWidth } : bounds
}
export function annotationDisplayBounds(mark: AnnotationMark, image: ImageTransform): AnnotationBounds {
  const { x, y, width, height } = annotationMarkBounds(mark)
  return pointsBounds([{ x, y }, { x: x + width, y }, { x, y: y + height }, { x: x + width, y: y + height }].map(point => toDisplayPoint(point, image)))
}
export function composeAnnotatedPrompt(overall: string, snapshot: AnnotationSnapshot): string {
  const normalized = validateAnnotationSnapshot(snapshot)
  return [overall.trim(), "第一张图片是未加标记的原始基准，第二张是同一原图的区域编号辅助图。请按编号说明统一修改原图；标记和编号只用于定位，不应出现在结果中。\n" +
    normalized.marks.map(mark => "#" + mark.number + "：" + mark.instruction).join("\n")].filter(Boolean).join("\n\n")
}
