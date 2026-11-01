import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import sharp from "sharp"
import { renderAnnotationOverlay } from "../lib/annotation-renderer"
import { validatePrivateImage } from "../lib/private-image-validation"
import { AnnotationValidationError, composeAnnotatedPrompt, createEmptyAnnotationSnapshot, serializeAnnotationSnapshot, toDisplayPoint, toEncodedPoint, validateAnnotationSnapshot, type AnnotationSnapshot } from "../lib/image-annotations"

function snapshot(orientation = 1): AnnotationSnapshot {
  const value = createEmptyAnnotationSnapshot(randomUUID(), { assetId: randomUUID(), width: 120, height: 80, orientation, pages: 1 })
  value.marks = [{ id: randomUUID(), number: 7, instruction: "区域改为绿色", geometry: { type: "rectangle", x: 80, y: 45, width: 25, height: 25 } }]
  return value
}

test("EXIF eight-way coordinates agree with independent non-square reference positions", () => {
  const expected = [[17, 23], [103, 23], [103, 57], [17, 57], [23, 17], [57, 17], [57, 103], [23, 103]]
  for (let orientation = 1; orientation <= 8; orientation++) {
    const image = snapshot(orientation).image, display = { x: expected[orientation - 1][0], y: expected[orientation - 1][1] }
    assert.deepEqual(toDisplayPoint({ x: 17, y: 23 }, image), display)
    assert.deepEqual(toEncodedPoint(display, image), { x: 17, y: 23 })
    for (const point of [{ x: 0, y: 0 }, { x: 120, y: 80 }, { x: 120, y: 0 }, { x: .25, y: 79.5 }]) {
      assert.deepEqual(toEncodedPoint(toDisplayPoint(point, image), image), point)
    }
  }
})

test("draft whitespace survives round trips; immutable submit normalizes without changing the draft", () => {
  const value = snapshot()
  value.marks[0].instruction = " keep this space \r\n"
  assert.equal(validateAnnotationSnapshot(value, { allowIncomplete: true }).marks[0].instruction, " keep this space \n")
  assert.equal(JSON.parse(serializeAnnotationSnapshot(value)).marks[0].instruction, " keep this space \n")
  const submitted = validateAnnotationSnapshot(value)
  assert.equal(submitted.marks[0].instruction, "keep this space")
  submitted.marks[0].instruction = "another request"
  assert.equal(value.marks[0].instruction, " keep this space \r\n")
  assert.match(composeAnnotatedPrompt("", value), /#7：keep this space/)
})

test("invalid or unbounded geometry is rejected instead of dropping marks or path points", () => {
  const invalid: Array<(value: AnnotationSnapshot) => void> = [
    value => { value.marks[0].instruction = " " },
    value => { value.marks[0].geometry = { type: "rectangle", x: -1, y: 0, width: 1, height: 1 } },
    value => { value.marks[0].geometry = { type: "rectangle", x: 119, y: 0, width: 2, height: 1 } },
    value => { value.marks[0].geometry = { type: "rectangle", x: NaN, y: 0, width: 1, height: 1 } },
    value => { value.marks[0].geometry = { type: "lasso", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] } },
    value => { value.marks[0].geometry = { type: "brush", brushWidth: 0, points: [{ x: 1, y: 1 }] } },
    value => { value.marks[0].geometry = { type: "brush", brushWidth: 2, points: Array.from({ length: 257 }, () => ({ x: 1, y: 1 })) } },
    value => { value.marks.push(structuredClone(value.marks[0])) },
    value => { value.marks = Array.from({ length: 21 }, (_, number) => ({ ...value.marks[0], id: randomUUID(), number: number + 1 })) },
    value => { value.marks = Array.from({ length: 17 }, (_, number) => ({ ...value.marks[0], id: randomUUID(), number: number + 1, geometry: { type: "brush", brushWidth: 1, points: Array.from({ length: 256 }, () => ({ x: 1, y: 1 })) } })) },
    value => { Object.assign(value.image, { pages: 2 }) },
    value => { Object.assign(value, { ownerId: "forged" }) },
  ]
  for (const change of invalid) { const value = snapshot(); change(value); assert.throws(() => validateAnnotationSnapshot(value), AnnotationValidationError) }
  const valid = snapshot()
  valid.marks[0].geometry = { type: "brush", brushWidth: 2, points: [{ x: 0, y: 80 }] }
  assert.equal(validateAnnotationSnapshot(valid).marks.length, 1, "an edge dot is a valid brush region")
})

test("rendered overlay follows actual EXIF pixels, leaves original bytes unchanged and validates source identity", async () => {
  const raw = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#123456" } })
    .composite([{ input: Buffer.from('<svg width="120" height="80"><rect width="35" height="30" fill="#ef1020"/></svg>') }]).png().toBuffer()
  for (let orientation = 1; orientation <= 8; orientation++) {
    const bytes = await sharp(raw).withMetadata({ orientation }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer()
    const originalCopy = Buffer.from(bytes), original = await validatePrivateImage(bytes), value = snapshot(orientation)
    const result = await renderAnnotationOverlay(original, value)
    assert.deepEqual(Buffer.from(original.bytes), originalCopy)
    const expected = await sharp(bytes).autoOrient().removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const actual = await sharp(Buffer.from(result.bytes)).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.equal(actual.info.width, expected.info.width); assert.equal(actual.info.height, expected.info.height)
    // The unmarked red corner must survive exactly; rendering cannot rotate twice or mirror the image incorrectly.
    const point = toDisplayPoint({ x: 10.5, y: 10.5 }, value.image)
    const offset = (Math.floor(point.y) * actual.info.width + Math.floor(point.x)) * 3
    assert.deepEqual(actual.data.subarray(offset, offset + 3), expected.data.subarray(offset, offset + 3))
    // A point inside the requested rectangle must receive the region tint.
    const inside = toDisplayPoint({ x: 100.5, y: 65.5 }, value.image)
    const painted = (Math.floor(inside.y) * actual.info.width + Math.floor(inside.x)) * 3
    assert.notDeepEqual(actual.data.subarray(painted, painted + 3), expected.data.subarray(painted, painted + 3))
    await assert.rejects(renderAnnotationOverlay(original, { ...value, image: { ...value.image, width: 121 } }), /尺寸或方向/)
  }
})

test("lasso and each brush path render actual regions, evenodd holes and brush width in all orientations", async () => {
  const cases = [
    { name: "lasso", geometry: { type: "lasso", points: [{ x: 90, y: 40 }, { x: 190, y: 40 }, { x: 190, y: 130 }, { x: 90, y: 130 }] }, painted: { x: 150.5, y: 95.5 }, clear: { x: 210.5, y: 95.5 } },
    { name: "single brush", geometry: { type: "brush", points: [{ x: 150, y: 100 }], brushWidth: 28 }, painted: { x: 158.5, y: 105.5 }, clear: { x: 166.5, y: 105.5 } },
    { name: "multi brush", geometry: { type: "brush", points: [{ x: 120, y: 100 }, { x: 190, y: 100 }], brushWidth: 16 }, painted: { x: 170.5, y: 106.5 }, clear: { x: 170.5, y: 111.5 } },
    { name: "twice-wound lasso", geometry: { type: "lasso", points: [{ x: 90, y: 40 }, { x: 190, y: 40 }, { x: 190, y: 130 }, { x: 90, y: 130 }, { x: 90, y: 40 }, { x: 190, y: 40 }, { x: 190, y: 130 }, { x: 90, y: 130 }] }, painted: { x: 150.5, y: 40.5 }, clear: { x: 150.5, y: 95.5 } },
  ] satisfies Array<{ name: string; geometry: AnnotationSnapshot["marks"][number]["geometry"]; painted: { x: number; y: number }; clear: { x: number; y: number } }>
  for (let orientation = 1; orientation <= 8; orientation++) {
    const bytes = await sharp({ create: { width: 240, height: 160, channels: 3, background: "#123456" } }).withMetadata({ orientation }).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer()
    const original = await validatePrivateImage(bytes)
    const expected = await sharp(bytes).autoOrient().removeAlpha().raw().toBuffer({ resolveWithObject: true })
    for (const item of cases) {
      const value = createEmptyAnnotationSnapshot(randomUUID(), { assetId: randomUUID(), width: 240, height: 160, orientation, pages: 1 })
      value.marks = [{ id: randomUUID(), number: 7, instruction: "只修改这个区域", geometry: item.geometry }]
      const result = await renderAnnotationOverlay(original, value)
      const actual = await sharp(Buffer.from(result.bytes)).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      assert.equal(actual.info.width, expected.info.width); assert.equal(actual.info.height, expected.info.height)
      const pixels = (point: { x: number; y: number }) => {
        const display = toDisplayPoint(point, value.image)
        const offset = (Math.floor(display.y) * expected.info.width + Math.floor(display.x)) * 3
        return [actual.data.subarray(offset, offset + 3), expected.data.subarray(offset, offset + 3)] as const
      }
      const marked = pixels(item.painted), outside = pixels(item.clear)
      assert.notDeepEqual(marked[0], marked[1], `${item.name} orientation ${orientation}: actual region, away from its number label`)
      assert.deepEqual(outside[0], outside[1], `${item.name} orientation ${orientation}: outside width / evenodd hole stays unchanged`)
      assert.deepEqual(Buffer.from(original.bytes), bytes)
    }
  }
})
