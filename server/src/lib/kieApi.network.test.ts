import { describe, expect, it } from 'vitest'
import {
  formatNetworkError,
  isTransientNetworkError,
  parseKieResultUrls,
} from './kieApi.js'
import { normalizeProviderErrorMessage } from './providerImageExtract.js'

describe('kie network helpers', () => {
  it('展开 cause 链，避免只剩 fetch failed', () => {
    const root = Object.assign(new Error('getaddrinfo ENOTFOUND cdn.example'), { code: 'ENOTFOUND' })
    const err = new Error('fetch failed', { cause: root })
    const text = formatNetworkError(err)
    expect(text).toContain('fetch failed')
    expect(text).toContain('ENOTFOUND')
  })

  it('识别瞬时网络错误', () => {
    expect(isTransientNetworkError(new Error('fetch failed'))).toBe(true)
    expect(isTransientNetworkError(new Error('HTTP 504 - gateway'))).toBe(true)
    expect(isTransientNetworkError(new Error('Kie 任务失败'))).toBe(false)
  })

  it('解析 resultUrls', () => {
    expect(parseKieResultUrls(JSON.stringify({ resultUrls: ['https://a.png', ''] }))).toEqual(['https://a.png'])
    expect(parseKieResultUrls('{}')).toEqual([])
    expect(() => parseKieResultUrls('{')).toThrow(/resultJson/)
  })
})

describe('normalizeProviderErrorMessage cause', () => {
  it('拼接 Error.cause', () => {
    const err = new Error('fetch failed', { cause: new Error('socket hang up') })
    expect(normalizeProviderErrorMessage(err)).toContain('fetch failed')
    expect(normalizeProviderErrorMessage(err)).toContain('socket hang up')
  })
})
