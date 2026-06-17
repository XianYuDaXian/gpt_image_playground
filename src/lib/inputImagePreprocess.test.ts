import { describe, expect, it } from 'vitest'
import {
  INPUT_IMAGE_MAX_PIXELS,
  calculateInputImagePixelFitSize,
  calculateInputImageWorkingSize,
  exceedsInputImagePixelLimit,
} from './inputImagePreprocess'

describe('exceedsInputImagePixelLimit', () => {
  it('将 3840×2160 视为未超限', () => {
    expect(exceedsInputImagePixelLimit(3840, 2160)).toBe(false)
  })

  it('将超出 4K 总像素视为超限', () => {
    expect(exceedsInputImagePixelLimit(4000, 3000)).toBe(true)
  })
})

describe('calculateInputImagePixelFitSize', () => {
  it('未超限时保持原始尺寸', () => {
    expect(calculateInputImagePixelFitSize(3000, 2000)).toEqual({
      width: 3000,
      height: 2000,
      wasResized: false,
    })
  })

  it('超限时等比收缩到像素上限以内', () => {
    const fitted = calculateInputImagePixelFitSize(4000, 3000)
    expect(fitted.wasResized).toBe(true)
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(INPUT_IMAGE_MAX_PIXELS)
    expect(fitted.width / fitted.height).toBeCloseTo(4000 / 3000, 2)
  })
})

describe('calculateInputImageWorkingSize', () => {
  it('保留未超限尺寸的参考图', () => {
    expect(calculateInputImageWorkingSize(1920, 1080, 2048)).toEqual({
      width: 1920,
      height: 1080,
      scale: 1,
      wasResized: false,
    })
  })

  it('在兜底缩小时将超长边等比收缩到目标长边', () => {
    expect(calculateInputImageWorkingSize(4032, 3024, 2048)).toEqual({
      width: 2048,
      height: 1536,
      scale: 2048 / 4032,
      wasResized: true,
    })
  })
})