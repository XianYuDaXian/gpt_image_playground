import { getCachedImage } from '../store'
import type { TaskRecord } from '../types'
import { peekCachedLoadedImageById, peekCachedLoadedImageSrc } from './imageLoadCache'

export function findTaskByImageId(imageId: string, tasks: TaskRecord[]) {
  return tasks.find((item) =>
    item.outputImages.includes(imageId) ||
    item.inputImageIds.includes(imageId) ||
    item.maskImageId === imageId,
  ) ?? null
}

export function resolveTaskImageRemoteUrl(imageId: string, tasks: TaskRecord[]) {
  const task = findTaskByImageId(imageId, tasks)
  return task?.imageUrlsById?.[imageId] || ''
}

export function resolveTaskImageDisplaySrc(imageId: string, tasks: TaskRecord[]) {
  if (!imageId) return ''

  const cachedById = peekCachedLoadedImageById(imageId)
  if (cachedById) return cachedById

  const memoryCached = getCachedImage(imageId)
  if (memoryCached) return memoryCached

  const remoteUrl = resolveTaskImageRemoteUrl(imageId, tasks)
  if (!remoteUrl) return ''

  const cachedByRemote = peekCachedLoadedImageSrc(remoteUrl)
  if (cachedByRemote) return cachedByRemote

  return remoteUrl
}