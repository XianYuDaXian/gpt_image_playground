import { describe, expect, it } from 'vitest'
import {
  buildKieUpstreamUsageJson,
  isKieNetworkFailureMessage,
  parseUpstreamUsageJson,
} from './kieFailedTaskRecover.js'

describe('kieFailedTaskRecover helpers', () => {
  it('识别网络失败文案', () => {
    expect(isKieNetworkFailureMessage('fetch failed')).toBe(true)
    expect(isKieNetworkFailureMessage('远端已出图但本地下载失败：fetch failed')).toBe(true)
    expect(isKieNetworkFailureMessage('HTTP 400 - moderated')).toBe(false)
  })

  it('读写 upstream usage json 保持向下兼容', () => {
    const first = buildKieUpstreamUsageJson({ kieTaskId: 'task_1' })
    expect(parseUpstreamUsageJson(first)).toEqual({ kieTaskId: 'task_1', kieResultUrls: [] })

    const second = buildKieUpstreamUsageJson({
      previousJson: first,
      kieResultUrls: ['https://a.png'],
    })
    expect(parseUpstreamUsageJson(second)).toEqual({
      kieTaskId: 'task_1',
      kieResultUrls: ['https://a.png'],
    })
  })
})
