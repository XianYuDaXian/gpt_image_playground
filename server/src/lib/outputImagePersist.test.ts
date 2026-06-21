import { describe, expect, it } from 'vitest'
import { assertAllOutputImagesPersisted, createOutputImagePersistQueue } from './outputImagePersist.js'

describe('createOutputImagePersistQueue', () => {
  it('并发入队时每张图都会独立保存且不覆盖', async () => {
    const savedKeys: string[] = []
    const queue = createOutputImagePersistQueue<string>({
      isInactive: () => false,
      getItemKey: (item) => item,
      persistOne: async (item) => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5))
        savedKeys.push(item)
        return true
      },
    })

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => queue.enqueue([`image-${index + 1}`])),
    )
    await queue.waitForIdle()

    expect(queue.getPersistedCount()).toBe(8)
    expect(savedKeys).toHaveLength(8)
    expect(new Set(savedKeys).size).toBe(8)
  })

  it('保存失败时不会误报全部成功', async () => {
    const queue = createOutputImagePersistQueue<string>({
      isInactive: () => false,
      getItemKey: (item) => item,
      persistOne: async (item) => item !== 'bad',
    })

    await queue.enqueue(['ok-1', 'bad', 'ok-2'])
    const ok = await queue.waitForIdle()

    expect(ok).toBe(false)
    expect(queue.getPersistedCount()).toBe(1)
    expect(queue.getMissingItems(['ok-1', 'bad', 'ok-2']).sort()).toEqual(['bad', 'ok-2'])
  })
})

describe('assertAllOutputImagesPersisted', () => {
  it('数量不一致时抛出明确错误', () => {
    expect(() => assertAllOutputImagesPersisted(4, 8)).toThrow('输出图片保存不完整（4/8）')
  })
})