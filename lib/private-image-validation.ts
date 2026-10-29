import sharp from "sharp"
import { AccountError } from "./auth/errors"
import { imageBytes, type ImageBytes } from "./relay-image"

export const MAX_PRIVATE_IMAGE_PIXELS = 16_777_216
export type ValidatedPrivateImage = ImageBytes & { width: number; height: number; orientation: number; pages: number }

/** 内存完整解码验证，返回原始字节；不会重编码或替换编辑基准。 */
export async function validatePrivateImage(bytes: Uint8Array, code: "REFERENCE_INVALID" | "MODEL_OUTPUT_INVALID" = "REFERENCE_INVALID"): Promise<ValidatedPrivateImage> {
  try {
    const image = imageBytes(bytes)
    const decoder = sharp(Buffer.from(image.bytes), { animated: true, failOn: "error", limitInputPixels: MAX_PRIVATE_IMAGE_PIXELS })
    const metadata = await decoder.metadata()
    const width = metadata.width ?? 0, height = metadata.pageHeight ?? metadata.height ?? 0, pages = metadata.pages ?? 1
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(pages) || width < 1 || height < 1 || pages < 1 ||
        width * height * pages > MAX_PRIVATE_IMAGE_PIXELS || width > 16384 || height > 16384 || pages > 100) throw new Error("bounded pixels")
    // metadata仅解析头部；stats实际解码全部像素，拒绝有魔数但截断/损坏的输出。
    await decoder.stats()
    return { ...image, width, height, pages, orientation: metadata.orientation ?? 1 }
  } catch {
    throw new AccountError(code, code === "MODEL_OUTPUT_INVALID" ? 502 : 400,
      code === "MODEL_OUTPUT_INVALID" ? "模型返回的图片无法完整解码，未保存为成功版本。" : "参考图损坏或超过解码限制，请缩小图片后重新选择（全部帧合计最多约 1600 万像素）。")
  }
}
