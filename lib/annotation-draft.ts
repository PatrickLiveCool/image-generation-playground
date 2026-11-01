import { annotationDisplayBounds, toDisplayPoint, toEncodedPoint, validateAnnotationSnapshot, type AnnotationDraft, type AnnotationMark, type AnnotationPoint, type AnnotationSnapshot } from "./image-annotations"

export const roundAnnotation = (value: number) => Math.round(value * 100) / 100
export function containImageRect(container: { width: number; height: number }, image: { width: number; height: number }) {
  const scale = Math.min(container.width / image.width, container.height / image.height)
  const width = image.width * scale, height = image.height * scale
  return { left: (container.width - width) / 2, top: (container.height - height) / 2, width, height, scale }
}

/** No lossy truncation: an overlong gesture is rejected by the shared validator. */
export function drawnAnnotation(type: AnnotationMark["geometry"]["type"], displayPoints: AnnotationPoint[], image: AnnotationSnapshot["image"], brushWidth: number): AnnotationMark["geometry"] {
  const points = displayPoints.map(point => toEncodedPoint(point, image)).map(point => ({ x: roundAnnotation(point.x), y: roundAnnotation(point.y) }))
  if (type === "rectangle") {
    const first = points[0], last = points.at(-1)!
    return { type, x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), width: roundAnnotation(Math.abs(last.x - first.x)), height: roundAnnotation(Math.abs(last.y - first.y)) }
  }
  return type === "brush" ? { type, points, brushWidth: roundAnnotation(brushWidth) } : { type, points }
}

export function replaceAnnotationMarks(draft: AnnotationDraft, marks: AnnotationMark[], nextNumber = draft.nextNumber): AnnotationDraft {
  return { snapshot: validateAnnotationSnapshot({ ...draft.snapshot, marks }, { allowIncomplete: true }), revision: draft.revision + 1, nextNumber: Math.max(draft.nextNumber, nextNumber) }
}

export function nudgeAnnotation(mark: AnnotationMark, image: AnnotationSnapshot["image"], dx: number, dy: number, resize = false): AnnotationMark {
  const bounds = annotationDisplayBounds(mark, image)
  const targetWidth = resize ? Math.max(1, bounds.width + dx) : bounds.width
  const targetHeight = resize ? Math.max(1, bounds.height + dy) : bounds.height
  const transform = (point: AnnotationPoint) => {
    const display = toDisplayPoint(point, image)
    const shifted = resize ? { x: bounds.x + (display.x - bounds.x) * targetWidth / (bounds.width || 1), y: bounds.y + (display.y - bounds.y) * targetHeight / (bounds.height || 1) } : { x: display.x + dx, y: display.y + dy }
    const encoded = toEncodedPoint(shifted, image)
    return { x: roundAnnotation(encoded.x), y: roundAnnotation(encoded.y) }
  }
  const geometry = mark.geometry
  if (geometry.type === "rectangle") {
    const a = transform({ x: geometry.x, y: geometry.y }), b = transform({ x: geometry.x + geometry.width, y: geometry.y + geometry.height })
    return { ...mark, geometry: { type: "rectangle", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: roundAnnotation(Math.abs(a.x - b.x)), height: roundAnnotation(Math.abs(a.y - b.y)) } }
  }
  return { ...mark, geometry: { ...geometry, points: geometry.points.map(transform), ...(geometry.type === "brush" && resize ? { brushWidth: roundAnnotation(Math.max(1, geometry.brushWidth + (dx || dy))) } : {}) } }
}
