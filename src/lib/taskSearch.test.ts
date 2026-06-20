import { describe, expect, it } from 'vitest'
import { matchesTaskFilters } from './taskSearch'
import type { TaskRecord } from '../types'

function task(partial: Partial<TaskRecord> & Pick<TaskRecord, 'id'>): TaskRecord {
  return {
    prompt: '',
    params: { size: '1024x1024', quality: 'auto', output_format: 'png', output_compression: null, moderation: 'auto', n: 1 },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    createdAt: 0,
    ...partial,
  } as TaskRecord
}

const baseFilters = {
  filterStatus: 'all' as const,
  filterTaskType: 'all' as const,
  filterFavorite: false,
  filterArchived: false,
  role: null,
  showUsageCodeTasksForAdmin: false,
  query: '',
}

describe('matchesTaskFilters 标签模式', () => {
  it('包含模式要求命中全部标签', () => {
    const catTask = task({ id: 'cat', prompt: '一只可爱的猫' })
    const dogTask = task({ id: 'dog', prompt: '一只可爱的狗' })

    expect(matchesTaskFilters(catTask, { ...baseFilters, tags: ['猫'], tagMode: 'include' })).toBe(true)
    expect(matchesTaskFilters(dogTask, { ...baseFilters, tags: ['猫'], tagMode: 'include' })).toBe(false)
    expect(matchesTaskFilters(catTask, { ...baseFilters, tags: ['猫', '可爱'], tagMode: 'include' })).toBe(true)
    expect(matchesTaskFilters(catTask, { ...baseFilters, tags: ['猫', '狗'], tagMode: 'include' })).toBe(false)
  })

  it('排除模式命中任一标签即过滤', () => {
    const catTask = task({ id: 'cat', prompt: '一只可爱的猫' })
    const dogTask = task({ id: 'dog', prompt: '一只可爱的狗' })

    expect(matchesTaskFilters(catTask, { ...baseFilters, tags: ['猫'], tagMode: 'exclude' })).toBe(false)
    expect(matchesTaskFilters(dogTask, { ...baseFilters, tags: ['猫'], tagMode: 'exclude' })).toBe(true)
    expect(matchesTaskFilters(catTask, { ...baseFilters, tags: ['猫', '狗'], tagMode: 'exclude' })).toBe(false)
    expect(matchesTaskFilters(dogTask, { ...baseFilters, tags: ['猫', '鸟'], tagMode: 'exclude' })).toBe(true)
  })

  it('未指定 tagMode 时默认按包含处理', () => {
    const catTask = task({ id: 'cat', prompt: '一只可爱的猫' })
    expect(matchesTaskFilters(catTask, { ...baseFilters, tags: ['猫'] })).toBe(true)
    expect(matchesTaskFilters(catTask, { ...baseFilters, tags: ['狗'] })).toBe(false)
  })
})