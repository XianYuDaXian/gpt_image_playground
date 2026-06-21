export interface OutputImagePersistQueue<T> {
  enqueue: (items: T[]) => Promise<boolean>
  waitForIdle: () => Promise<boolean>
  getPersistedCount: () => number
  getMissingItems: (items: T[]) => T[]
}

/** 串行化多图保存，避免并发回调争用同一文件索引。 */
export function createOutputImagePersistQueue<T>(options: {
  isInactive: () => boolean
  persistOne: (item: T) => Promise<boolean>
  getItemKey: (item: T) => string
}): OutputImagePersistQueue<T> {
  let persistedCount = 0
  const persistedKeys = new Set<string>()
  let persistQueue: Promise<boolean> = Promise.resolve(true)

  const enqueue = (items: T[]) => {
    persistQueue = persistQueue.then(async () => {
      for (const item of items) {
        if (options.isInactive()) return false

        const key = options.getItemKey(item)
        if (persistedKeys.has(key)) continue

        const ok = await options.persistOne(item)
        if (!ok) return false

        persistedKeys.add(key)
        persistedCount += 1
      }
      return true
    })
    return persistQueue
  }

  return {
    enqueue,
    waitForIdle: () => persistQueue,
    getPersistedCount: () => persistedCount,
    getMissingItems: (items) => items.filter((item) => !persistedKeys.has(options.getItemKey(item))),
  }
}

export function assertAllOutputImagesPersisted(persistedCount: number, expectedCount: number) {
  if (persistedCount !== expectedCount) {
    throw new Error(`输出图片保存不完整（${persistedCount}/${expectedCount}）`)
  }
}