import { describe, expect, it } from 'vitest'
import {
  formatProviderUnusedRemaining,
  listProviderUnusedUsageCodes,
  type ProviderUnusedUsageCodeSource,
} from './providerUnusedUsageCodes'

function code(
  partial: Partial<ProviderUnusedUsageCodeSource> & Pick<ProviderUnusedUsageCodeSource, 'id' | 'name'>,
): ProviderUnusedUsageCodeSource {
  return {
    ...partial,
  }
}

describe('listProviderUnusedUsageCodes', () => {
  it('纳入授权且 remaining>0 的使用码，排除 remaining=0 与未授权项', () => {
    const usageCodes = [
      code({
        id: 'a',
        name: '可用',
        allowedProviderProfileIds: ['p1'],
        providerRemainingImageCredits: { p1: 3 },
      }),
      code({
        id: 'b',
        name: '已用尽',
        allowedProviderProfileIds: ['p1'],
        providerRemainingImageCredits: { p1: 0 },
      }),
      code({
        id: 'c',
        name: '未授权',
        allowedProviderProfileIds: ['p2'],
        providerRemainingImageCredits: { p1: 5, p2: 5 },
      }),
    ]

    expect(listProviderUnusedUsageCodes(usageCodes, 'p1', 'images')).toEqual([
      { id: 'a', name: '可用', remaining: 3 },
    ])
  })

  it('显式不限配额排在最前', () => {
    const usageCodes = [
      code({
        id: 'num',
        name: '有限额度',
        allowedProviderProfileIds: ['p1'],
        providerRemainingImageCredits: { p1: 8 },
      }),
      code({
        id: 'unlim',
        name: '不限额度',
        allowedProviderProfileIds: ['p1'],
        providerImageQuotas: { p1: null },
        providerRemainingImageCredits: { p1: null },
      }),
    ]

    expect(listProviderUnusedUsageCodes(usageCodes, 'p1', 'images').map((item) => item.id)).toEqual([
      'unlim',
      'num',
    ])
  })

  it('数字剩余按降序，同剩余按备注名 localeCompare zh-CN', () => {
    const usageCodes = [
      code({
        id: 'b',
        name: '香蕉',
        allowedProviderProfileIds: null,
        providerRemainingImageCredits: { p1: 2 },
      }),
      code({
        id: 'a',
        name: '苹果',
        allowedProviderProfileIds: null,
        providerRemainingImageCredits: { p1: 5 },
      }),
      code({
        id: 'c',
        name: '橙子',
        allowedProviderProfileIds: null,
        providerRemainingImageCredits: { p1: 5 },
      }),
    ]

    const sameRemainingNames = ['苹果', '橙子'].sort((left, right) => left.localeCompare(right, 'zh-CN'))
    expect(listProviderUnusedUsageCodes(usageCodes, 'p1', 'images').map((item) => item.name)).toEqual([
      ...sameRemainingNames,
      '香蕉',
    ])
  })

  it('视频端点读取 video remaining 与 video quotas', () => {
    const usageCodes = [
      code({
        id: 'v1',
        name: '视频可用',
        allowedProviderProfileIds: ['p1'],
        providerRemainingImageCredits: { p1: 99 },
        providerRemainingVideoCredits: { p1: 4 },
      }),
      code({
        id: 'v2',
        name: '视频不限',
        allowedProviderProfileIds: ['p1'],
        providerVideoQuotas: { p1: null },
        providerRemainingVideoCredits: { p1: null },
      }),
    ]

    expect(listProviderUnusedUsageCodes(usageCodes, 'p1', 'videos')).toEqual([
      { id: 'v2', name: '视频不限', remaining: null },
      { id: 'v1', name: '视频可用', remaining: 4 },
    ])
  })

  it('备注名为空时回退 code，再回退 id', () => {
    const usageCodes = [
      code({
        id: 'fallback-id',
        name: '   ',
        code: 'CODE-1',
        allowedProviderProfileIds: null,
        providerRemainingImageCredits: { p1: 1 },
      }),
      code({
        id: 'only-id',
        name: '',
        code: '  ',
        allowedProviderProfileIds: null,
        providerRemainingImageCredits: { p1: 2 },
      }),
    ]

    expect(listProviderUnusedUsageCodes(usageCodes, 'p1', 'images')).toEqual([
      { id: 'only-id', name: 'only-id', remaining: 2 },
      { id: 'fallback-id', name: 'CODE-1', remaining: 1 },
    ])
  })

  it('allowedProviderProfileIds 为空数组时不纳入', () => {
    const usageCodes = [
      code({
        id: 'empty',
        name: '空授权列表',
        allowedProviderProfileIds: [],
        providerRemainingImageCredits: { p1: 10 },
      }),
    ]

    expect(listProviderUnusedUsageCodes(usageCodes, 'p1', 'images')).toEqual([])
  })
})

describe('formatProviderUnusedRemaining', () => {
  it('null 显示为不限，数字原样字符串化', () => {
    expect(formatProviderUnusedRemaining(null)).toBe('不限')
    expect(formatProviderUnusedRemaining(0)).toBe('0')
    expect(formatProviderUnusedRemaining(12)).toBe('12')
  })
})
