import assert from "node:assert/strict"
import { test } from "node:test"
import sharp from "sharp"
import { AccountError } from "../lib/auth/errors"
import { validatePrivateImage } from "../lib/private-image-validation"

test("完整解码PNG/JPEG/WebP/GIF并原样保留原始图片字节与方向", async () => {
  const source = () => sharp({ create: { width: 16, height: 8, channels: 3, background: "#345678" } })
  const fixtures = [await source().png().toBuffer(), await source().jpeg().withMetadata({ orientation: 6 }).toBuffer(), await source().webp().toBuffer(),
    Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")]
  for (const bytes of fixtures) {
    const result = await validatePrivateImage(bytes)
    assert.deepEqual(result.bytes, bytes)
    assert.ok(result.width > 0 && result.height > 0)
  }
  const oriented = await validatePrivateImage(fixtures[1])
  assert.equal(oriented.orientation, 6)
  assert.equal(oriented.width, 16)
  assert.equal(oriented.height, 8)
})

test("只有魔数或头部、截断像素、超过累计像素限制均不能保存成功", async () => {
  const valid = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123456" } }).png().toBuffer()
  const tooLarge = await sharp({ create: { width: 6000, height: 3000, channels: 3, background: "white" } }).png().toBuffer()
  for (const bytes of [valid.subarray(0,8), valid.subarray(0,40), valid.subarray(0,valid.length-30), tooLarge]) {
    await assert.rejects(validatePrivateImage(bytes,"MODEL_OUTPUT_INVALID"), error => error instanceof AccountError && error.code === "MODEL_OUTPUT_INVALID")
  }
})
