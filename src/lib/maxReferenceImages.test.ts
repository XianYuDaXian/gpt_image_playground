import { describe, expect, it } from 'vitest'
import {
  defaultMaxReferenceImages,
  normalizeMaxReferenceImages,
  resolveEffectiveMaxReferenceImages,
} from './maxReferenceImages'

describe('maxReferenceImages', () => {
  it('特殊端点默认 3，普通端点默认 16', () => {
    expect(defaultMaxReferenceImages('venice_images')).toBe(3)
    expect(defaultMaxReferenceImages('wavespeed')).toBe(3)
    expect(defaultMaxReferenceImages('kie')).toBe(3)
    expect(defaultMaxReferenceImages('images')).toBe(16)
    expect(defaultMaxReferenceImages('responses')).toBe(16)
    expect(defaultMaxReferenceImages('videos')).toBe(16)
  })

  it('规范化非法值与边界', () => {
    expect(normalizeMaxReferenceImages('images', undefined)).toBe(16)
    expect(normalizeMaxReferenceImages('kie', null)).toBe(3)
    expect(normalizeMaxReferenceImages('images', 'abc')).toBe(16)
    expect(normalizeMaxReferenceImages('images', 0)).toBe(1)
    expect(normalizeMaxReferenceImages('images', 99)).toBe(16)
    expect(normalizeMaxReferenceImages('venice_images', 5.8)).toBe(5)
  })

  it('特殊端点叠加开关后得到实际上限', () => {
    expect(resolveEffectiveMaxReferenceImages({
      apiMode: 'venice_images',
      maxReferenceImages: 5,
      veniceEditEnabled: true,
      veniceMultiEditEnabled: true,
    })).toBe(5)

    expect(resolveEffectiveMaxReferenceImages({
      apiMode: 'wavespeed',
      maxReferenceImages: 8,
      veniceEditEnabled: true,
      veniceMultiEditEnabled: false,
    })).toBe(1)

    expect(resolveEffectiveMaxReferenceImages({
      apiMode: 'kie',
      maxReferenceImages: 8,
      veniceEditEnabled: false,
      veniceMultiEditEnabled: false,
    })).toBe(0)
  })

  it('普通端点直接使用配置值', () => {
    expect(resolveEffectiveMaxReferenceImages({
      apiMode: 'images',
      maxReferenceImages: 2,
    })).toBe(2)

    expect(resolveEffectiveMaxReferenceImages({
      apiMode: 'videos',
      maxReferenceImages: 4,
    })).toBe(4)
  })
})
