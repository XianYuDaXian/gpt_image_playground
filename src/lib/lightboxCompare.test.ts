import { describe, expect, it } from 'vitest'
import { resolveLightboxCompareTarget } from './lightboxCompare'
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

describe('resolveLightboxCompareTarget', () => {
  it('输出图对比首张参考图', () => {
    const result = resolveLightboxCompareTarget('out-1', [
      task({ id: 't1', inputImageIds: ['in-1'], outputImages: ['out-1'] }),
    ])
    expect(result).toEqual({
      compareImageId: 'in-1',
      primaryLabel: '生成图',
      compareLabel: '参考图',
    })
  })

  it('输出图优先对比遮罩主图', () => {
    const result = resolveLightboxCompareTarget('out-1', [
      task({
        id: 't1',
        inputImageIds: ['in-1', 'mask-target'],
        maskTargetImageId: 'mask-target',
        outputImages: ['out-1'],
      }),
    ])
    expect(result?.compareImageId).toBe('mask-target')
  })

  it('参考图对比同索引生成图', () => {
    const result = resolveLightboxCompareTarget('in-2', [
      task({ id: 't1', inputImageIds: ['in-1', 'in-2'], outputImages: ['out-1', 'out-2'] }),
    ])
    expect(result).toEqual({
      compareImageId: 'out-2',
      primaryLabel: '参考图',
      compareLabel: '生成图',
    })
  })

  it('无参考图时不提供对比', () => {
    expect(resolveLightboxCompareTarget('out-1', [
      task({ id: 't1', outputImages: ['out-1'] }),
    ])).toBeNull()
  })
})