import { describe, expect, it } from 'vitest'
import {
  extractImagesFromProviderResponse,
  isImagesOnlyModel,
  normalizeProviderErrorMessage,
  summarizeResponseForError,
} from './providerImageExtract.js'

const SAMPLE_B64 = 'iVBORw0KGgo='

describe('providerImageExtract', () => {
  it('识别 images-only 模型', () => {
    expect(isImagesOnlyModel('gpt-image-2')).toBe(true)
    expect(isImagesOnlyModel('gpt-5.5')).toBe(false)
    expect(isImagesOnlyModel('gpt-5.4')).toBe(false)
  })

  it('解析 Images API data[0].b64_json', async () => {
    const images = await extractImagesFromProviderResponse({
      created: 1,
      data: [{ b64_json: SAMPLE_B64 }],
    })
    expect(images).toHaveLength(1)
    expect(images[0]?.source).toBe('images')
    expect(images[0]?.buffer.length).toBeGreaterThan(0)
  })

  it('解析 Responses API image_generation_call.result', async () => {
    const images = await extractImagesFromProviderResponse({
      id: 'resp_1',
      model: 'gpt-5.5',
      status: 'completed',
      output: [
        {
          type: 'image_generation_call',
          status: 'completed',
          result: SAMPLE_B64,
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      ],
    })
    expect(images).toHaveLength(1)
    expect(images[0]?.source).toBe('responses')
    expect(images[0]?.buffer.length).toBeGreaterThan(0)
  })

  it('无图响应返回空数组', async () => {
    const images = await extractImagesFromProviderResponse({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      ],
    })
    expect(images).toHaveLength(0)
    expect(summarizeResponseForError({
      status: 'completed',
      output: [{ type: 'message' }],
    })).toContain('output_types=message')
  })
})


describe('normalizeProviderErrorMessage', () => {
  it('把 null/字面量 null 转成可读失败文案', () => {
    expect(normalizeProviderErrorMessage(null)).toBe('生成失败，请联系管理员')
    expect(normalizeProviderErrorMessage(new Error('null'))).toBe('生成失败，请联系管理员')
    expect(normalizeProviderErrorMessage({ message: null })).toBe('生成失败，请联系管理员')
  })

  it('保留真实错误文案', () => {
    expect(normalizeProviderErrorMessage(new Error('接口未返回图片数据'))).toBe('接口未返回图片数据')
  })
})
