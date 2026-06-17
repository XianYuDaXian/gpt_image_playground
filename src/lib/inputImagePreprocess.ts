import { formatByteSize } from './imageLoadProgress'
import { canvasToBlob, loadImage } from './canvasImage'

/** 参考图长边上限，与模型最大边长一致 */
export const INPUT_IMAGE_MAX_EDGE = 3840
/** 总像素上限：按 3840 方图计，避免方图被 16:9 4K 像素上限过度缩小 */
export const INPUT_IMAGE_MAX_PIXELS = INPUT_IMAGE_MAX_EDGE * INPUT_IMAGE_MAX_EDGE
/** 参考图提交体积上限，优先通过重新编码压缩 */
export const DEFAULT_INPUT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** 分辨率逐步收缩的下限长边 */
const MIN_INPUT_IMAGE_EDGE = 1536

const WEBP_QUALITY_START = 0.96
const WEBP_QUALITY_MIN = 0.88
const WEBP_QUALITY_STEP = 0.02
const RESIZE_STEP = 0.95

export interface PreparedInputImage {
  dataUrl: string
  originalWidth: number
  originalHeight: number
  width: number
  height: number
  originalBytes: number
  outputBytes: number
  wasResized: boolean
  wasReencoded: boolean
}

export function exceedsInputImagePixelLimit(
  width: number,
  height: number,
  maxEdge = INPUT_IMAGE_MAX_EDGE,
  maxPixels = INPUT_IMAGE_MAX_PIXELS,
): boolean {
  return Math.max(width, height) > maxEdge || width * height > maxPixels
}

export function calculateInputImagePixelFitSize(
  width: number,
  height: number,
  maxEdge = INPUT_IMAGE_MAX_EDGE,
  maxPixels = INPUT_IMAGE_MAX_PIXELS,
) {
  let fittedWidth = width
  let fittedHeight = height
  let wasResized = false

  const longestEdge = Math.max(fittedWidth, fittedHeight)
  if (longestEdge > maxEdge) {
    const edgeScale = maxEdge / longestEdge
    fittedWidth = Math.max(1, Math.floor(fittedWidth * edgeScale))
    fittedHeight = Math.max(1, Math.floor(fittedHeight * edgeScale))
    wasResized = true
  }

  let pixels = fittedWidth * fittedHeight
  if (pixels > maxPixels) {
    const pixelScale = Math.sqrt(maxPixels / pixels)
    fittedWidth = Math.max(1, Math.floor(fittedWidth * pixelScale))
    fittedHeight = Math.max(1, Math.floor(fittedHeight * pixelScale))
    wasResized = true
  }

  while (fittedWidth * fittedHeight > maxPixels && (fittedWidth > 1 || fittedHeight > 1)) {
    if (fittedWidth >= fittedHeight) fittedWidth -= 1
    else fittedHeight -= 1
    wasResized = true
  }

  return {
    width: fittedWidth,
    height: fittedHeight,
    wasResized,
  }
}

export function calculateInputImageWorkingSize(
  width: number,
  height: number,
  maxEdge: number,
) {
  const longestEdge = Math.max(width, height)
  if (longestEdge <= maxEdge) {
    return { width, height, scale: 1, wasResized: false }
  }

  const scale = maxEdge / longestEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
    wasResized: true,
  }
}

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length
  const base64Length = dataUrl.length - commaIndex - 1
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(base64Length * 3 / 4) - padding)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

async function encodeCanvasDataUrl(
  canvas: HTMLCanvasElement,
  maxBytes: number,
): Promise<{ dataUrl: string; bytes: number }> {
  const tryEncode = async (quality: number) => {
    const blob = await canvasToBlob(canvas, 'image/webp', quality)
    return { blob, dataUrl: await blobToDataUrl(blob), bytes: blob.size }
  }

  let quality = WEBP_QUALITY_START
  let last: { blob: Blob; dataUrl: string; bytes: number } | null = null
  while (quality >= WEBP_QUALITY_MIN) {
    const encoded = await tryEncode(quality)
    last = encoded
    if (encoded.bytes <= maxBytes) return encoded
    quality -= WEBP_QUALITY_STEP
  }
  if (last) return last
  return await tryEncode(WEBP_QUALITY_MIN)
}

async function encodeImageAtSize(
  image: HTMLImageElement,
  width: number,
  height: number,
  maxBytes: number,
): Promise<{ dataUrl: string; bytes: number }> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0, width, height)
  return encodeCanvasDataUrl(canvas, maxBytes)
}

export async function prepareInputImageDataUrl(
  dataUrl: string,
  options?: { maxBytes?: number },
): Promise<PreparedInputImage> {
  const maxBytes = options?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES
  const image = await loadImage(dataUrl)
  const originalWidth = image.naturalWidth
  const originalHeight = image.naturalHeight
  const originalBytes = estimateDataUrlBytes(dataUrl)
  const overPixelLimit = exceedsInputImagePixelLimit(originalWidth, originalHeight)

  if (!overPixelLimit && originalBytes <= maxBytes) {
    return {
      dataUrl,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
      originalBytes,
      outputBytes: originalBytes,
      wasResized: false,
      wasReencoded: false,
    }
  }

  // 未超分辨率上限：只压体积，不缩分辨率
  if (!overPixelLimit) {
    const encoded = await encodeImageAtSize(image, originalWidth, originalHeight, maxBytes)
    return {
      dataUrl: encoded.dataUrl,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
      originalBytes,
      outputBytes: encoded.bytes,
      wasResized: false,
      wasReencoded: true,
    }
  }

  // 超分辨率上限：先收到长边/像素上限内，再压体积；仍超限则继续缩分辨率
  const pixelFit = calculateInputImagePixelFitSize(originalWidth, originalHeight)
  let width = pixelFit.width
  let height = pixelFit.height
  let wasResized = pixelFit.wasResized
  let encoded = await encodeImageAtSize(image, width, height, maxBytes)

  if (encoded.bytes <= maxBytes) {
    return {
      dataUrl: encoded.dataUrl,
      originalWidth,
      originalHeight,
      width,
      height,
      originalBytes,
      outputBytes: encoded.bytes,
      wasResized,
      wasReencoded: true,
    }
  }

  let targetMaxEdge = Math.max(width, height)
  while (encoded.bytes > maxBytes && targetMaxEdge > MIN_INPUT_IMAGE_EDGE) {
    targetMaxEdge = Math.max(MIN_INPUT_IMAGE_EDGE, Math.floor(targetMaxEdge * RESIZE_STEP))
    const nextSize = calculateInputImageWorkingSize(originalWidth, originalHeight, targetMaxEdge)
    width = nextSize.width
    height = nextSize.height
    wasResized = true
    encoded = await encodeImageAtSize(image, width, height, maxBytes)
  }

  return {
    dataUrl: encoded.dataUrl,
    originalWidth,
    originalHeight,
    width,
    height,
    originalBytes,
    outputBytes: encoded.bytes,
    wasResized,
    wasReencoded: true,
  }
}

export function formatInputImageCompressionMessage(prepared: PreparedInputImage): string | null {
  if (!prepared.wasResized && !prepared.wasReencoded) return null

  const sizePart = `${formatByteSize(prepared.originalBytes)} → ${formatByteSize(prepared.outputBytes)}`
  if (!prepared.wasResized) {
    return `参考图体积已自动压缩（${sizePart}）`
  }

  return `参考图已自动压缩（${prepared.originalWidth}×${prepared.originalHeight} → ${prepared.width}×${prepared.height}，${sizePart}）`
}