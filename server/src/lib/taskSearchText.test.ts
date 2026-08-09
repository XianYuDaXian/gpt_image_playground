import { describe, expect, it } from 'vitest'
import {
  buildSizeSearchText,
  buildTaskSearchText,
  formatImageRatio,
  matchesSearchTags,
  matchesTaskSearch,
  normalizeSearchText,
  searchableFromRow,
  searchableFromSerialized,
  toUiStatus,
  type SearchableRowInput,
  type SerializedTaskSearchInput,
} from './taskSearchText.js'

interface FixturePair {
  row: SearchableRowInput
  images: Array<{ kind: string; id: string; width: number | null; height: number | null }>
  provider: { name: string; remarkName: string | null } | null
  serialized: (role: 'admin' | 'user') => SerializedTaskSearchInput
}

function fixtureImageTask(): FixturePair {
  return {
    row: {
      prompt: '一只猫在草地',
      paramsJson: JSON.stringify({ size: '1024x1024', quality: 'high', output_format: 'png', n: 2 }),
      taskType: 'image',
      status: 'succeeded',
      currentStep: 'completed',
      providerProfileId: 'p1',
      providerProfileModel: 'gpt-image-1',
      ownerKind: 'usage_code',
      ownerLabel: '使用码别名A',
      ownerUsageCodeCode: '9KKVMJK5ALP_',
    },
    images: [
      { kind: 'input', id: 'i1', width: 800, height: 600 },
      { kind: 'output', id: 'o1', width: 1024, height: 1024 },
      { kind: 'output', id: 'o2', width: 512, height: 512 },
      { kind: 'mask', id: 'm1', width: 1024, height: 1024 },
    ],
    provider: { name: 'Venice API', remarkName: '威尼斯' },
    serialized: (role) => ({
      prompt: '一只猫在草地',
      params: { size: '1024x1024', quality: 'high', output_format: 'png', n: 2 },
      taskType: 'image',
      status: 'done',
      currentStep: 'completed',
      maskImageId: 'm1',
      providerProfileName: role === 'admin' ? '威尼斯' : 'Venice API',
      providerProfileId: 'p1',
      providerProfileModel: 'gpt-image-1',
      ownerKind: 'usage_code',
      ownerLabel: role === 'admin' ? '使用码别名A' : '9KKVMJK5ALP_',
      ownerUsageCode: { code: '9KKVMJK5ALP_', name: role === 'admin' ? '使用码别名A' : '9KKVMJK5ALP_' },
      outputImages: ['o1', 'o2'],
      imageSizesById: {
        o1: { width: 1024, height: 1024 },
        o2: { width: 512, height: 512 },
      },
    }),
  }
}

function fixtureVideoTask(): FixturePair {
  return {
    row: {
      prompt: '小狗在跑步',
      paramsJson: JSON.stringify({ aspect_ratio: '16:9', resolution: '720p', duration: 10 }),
      taskType: 'video',
      status: 'failed',
      currentStep: 'downloading',
      providerProfileId: 'p2',
      providerProfileModel: 'video-model',
      ownerKind: 'usage_code',
      ownerLabel: '使用码别名B',
      ownerUsageCodeCode: 'CODE_B',
    },
    images: [
      { kind: 'video_output', id: 'v1', width: null, height: null },
    ],
    provider: { name: 'WaveSpeed API', remarkName: '疾速' },
    serialized: (role) => ({
      prompt: '小狗在跑步',
      params: { aspect_ratio: '16:9', resolution: '720p', duration: 10 },
      taskType: 'video',
      status: 'error',
      currentStep: 'downloading',
      maskImageId: null,
      providerProfileName: role === 'admin' ? '疾速' : 'WaveSpeed API',
      providerProfileId: 'p2',
      providerProfileModel: 'video-model',
      ownerKind: 'usage_code',
      ownerLabel: role === 'admin' ? '使用码别名B' : 'CODE_B',
      ownerUsageCode: { code: 'CODE_B', name: role === 'admin' ? '使用码别名B' : 'CODE_B' },
      outputImages: [],
      imageSizesById: {},
    }),
  }
}

function fixtureAdminTask(): FixturePair {
  return {
    row: {
      prompt: '管理员手工任务',
      paramsJson: '{}',
      taskType: 'image',
      status: 'succeeded',
      currentStep: 'done',
      providerProfileId: null,
      providerProfileModel: null,
      ownerKind: 'admin',
      ownerLabel: '管理员',
      ownerUsageCodeCode: null,
    },
    images: [
      { kind: 'output', id: 'oa', width: 800, height: 600 },
    ],
    provider: null,
    serialized: () => ({
      prompt: '管理员手工任务',
      params: {},
      taskType: 'image',
      status: 'done',
      currentStep: 'done',
      maskImageId: null,
      providerProfileName: null,
      providerProfileId: null,
      providerProfileModel: null,
      ownerKind: 'admin',
      ownerLabel: '管理员',
      ownerUsageCode: null,
      outputImages: ['oa'],
      imageSizesById: { oa: { width: 800, height: 600 } },
    }),
  }
}

function buildRowTask(pair: FixturePair, role: 'admin' | 'user') {
  return searchableFromRow(pair.row, pair.images, pair.provider, role)
}

describe('搜索文本基础工具', () => {
  it('normalizeSearchText 统一全角与乘号', () => {
    expect(normalizeSearchText('A×B：C')).toBe('axb:c')
    expect(normalizeSearchText('Hello 猫')).toBe('hello 猫')
  })

  it('formatImageRatio 计算最简比例', () => {
    expect(formatImageRatio(1024, 1024)).toBe('1:1')
    expect(formatImageRatio(800, 600)).toBe('4:3')
    expect(formatImageRatio(0, 600)).toBe('')
    expect(formatImageRatio(800, 0)).toBe('')
  })

  it('buildSizeSearchText 输出多种尺寸写法', () => {
    expect(buildSizeSearchText(1024, 1024)).toBe('1024x1024 1024×1024 1:1')
  })

  it('toUiStatus 转换后端状态', () => {
    expect(toUiStatus('succeeded')).toBe('done')
    expect(toUiStatus('failed')).toBe('error')
    expect(toUiStatus('canceled')).toBe('error')
    expect(toUiStatus('queued')).toBe('running')
    expect(toUiStatus('processing')).toBe('running')
  })
})

describe('轻量行与序列化对象的搜索文本等价', () => {
  it('图片任务在管理员与用户角色下文本一致', () => {
    for (const role of ['admin', 'user'] as const) {
      const rowTask = buildRowTask(fixtureImageTask(), role)
      const serializedTask = searchableFromSerialized(fixtureImageTask().serialized(role))
      expect(buildTaskSearchText(rowTask, role)).toBe(buildTaskSearchText(serializedTask, role))
    }
  })

  it('视频任务在管理员与用户角色下文本一致', () => {
    for (const role of ['admin', 'user'] as const) {
      const pair = fixtureVideoTask()
      const rowTask = buildRowTask(pair, role)
      const serializedTask = searchableFromSerialized(pair.serialized(role))
      expect(buildTaskSearchText(rowTask, role)).toBe(buildTaskSearchText(serializedTask, role))
    }
  })

  it('管理员任务在管理员与用户角色下文本一致', () => {
    for (const role of ['admin', 'user'] as const) {
      const pair = fixtureAdminTask()
      const rowTask = buildRowTask(pair, role)
      const serializedTask = searchableFromSerialized(pair.serialized(role))
      expect(buildTaskSearchText(rowTask, role)).toBe(buildTaskSearchText(serializedTask, role))
    }
  })
})

describe('matchesTaskSearch 命中规则', () => {
  const pairA = fixtureImageTask()
  const adminA = buildRowTask(pairA, 'admin')
  const userA = buildRowTask(pairA, 'user')

  it('按使用码与别名匹配', () => {
    expect(matchesTaskSearch(adminA, '9KKVMJK5ALP_', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, '使用码别名A', 'admin')).toBe(true)
    expect(matchesTaskSearch(userA, '使用码别名A', 'user')).toBe(false)
  })

  it('按提示词、尺寸、比例匹配', () => {
    expect(matchesTaskSearch(adminA, '猫', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, '1024x1024', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, '1:1', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, '512x512', 'admin')).toBe(true)
  })

  it('按状态、类型、参数匹配', () => {
    expect(matchesTaskSearch(adminA, '已完成', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, 'done', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, '图片', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, 'image', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, 'high', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, 'png', 'admin')).toBe(true)
  })

  it('按 provider 名称与角色区分', () => {
    expect(matchesTaskSearch(adminA, '威尼斯', 'admin')).toBe(true)
    expect(matchesTaskSearch(userA, '威尼斯', 'user')).toBe(false)
    expect(matchesTaskSearch(userA, 'Venice', 'user')).toBe(true)
  })

  it('按遮罩关键词匹配', () => {
    expect(matchesTaskSearch(adminA, 'mask', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, '遮罩', 'admin')).toBe(true)
  })

  it('未命中的词返回 false', () => {
    expect(matchesTaskSearch(adminA, '不存在的词', 'admin')).toBe(false)
  })

  it('视频任务按分辨率、时长、类型、状态匹配', () => {
    const adminB = buildRowTask(fixtureVideoTask(), 'admin')
    expect(matchesTaskSearch(adminB, '16:9', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, '720p', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, '10', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, '10s', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, '视频', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, 'video', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, '失败', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, 'error', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, '疾速', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, 'CODE_B', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminB, '小狗', 'admin')).toBe(true)
  })

  it('管理员任务按归属与比例匹配', () => {
    const adminC = buildRowTask(fixtureAdminTask(), 'admin')
    expect(matchesTaskSearch(adminC, '管理员', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminC, '4:3', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminC, '使用码', 'admin')).toBe(false)
  })

  it('空查询匹配所有', () => {
    expect(matchesTaskSearch(adminA, '', 'admin')).toBe(true)
    expect(matchesTaskSearch(adminA, '   ', 'admin')).toBe(true)
  })
})

describe('matchesSearchTags 组合过滤', () => {
  const adminA = buildRowTask(fixtureImageTask(), 'admin')
  const adminB = buildRowTask(fixtureVideoTask(), 'admin')

  it('包含模式要求全部标签命中', () => {
    expect(matchesSearchTags(adminA, '', ['猫', 'png'], 'include', 'admin')).toBe(true)
    expect(matchesSearchTags(adminA, '', ['猫', 'video'], 'include', 'admin')).toBe(false)
  })

  it('排除模式命中任一标签即隐藏', () => {
    expect(matchesSearchTags(adminA, '', ['9KKVMJK5ALP_'], 'exclude', 'admin')).toBe(false)
    expect(matchesSearchTags(adminB, '', ['9KKVMJK5ALP_'], 'exclude', 'admin')).toBe(true)
  })

  it('查询词与标签同时生效', () => {
    expect(matchesSearchTags(adminA, '猫', ['png'], 'include', 'admin')).toBe(true)
    expect(matchesSearchTags(adminA, '不存在', ['png'], 'include', 'admin')).toBe(false)
  })

  it('无标签时仅按查询词过滤', () => {
    expect(matchesSearchTags(adminA, '', [], 'include', 'admin')).toBe(true)
    expect(matchesSearchTags(adminA, '9KKVMJK5ALP_', [], 'include', 'admin')).toBe(true)
  })
})