import {
  createInitialImageLoadProgress,
  type ImageLoadProgress,
} from './imageLoadProgress'

const progressById = new Map<string, ImageLoadProgress>()
const listenersById = new Map<string, Set<(progress: ImageLoadProgress) => void>>()

export function getVideoLoadProgress(videoId: string): ImageLoadProgress {
  return progressById.get(videoId) ?? createInitialImageLoadProgress()
}

export function setVideoLoadProgress(videoId: string, progress: ImageLoadProgress) {
  progressById.set(videoId, progress)
  const listeners = listenersById.get(videoId)
  if (!listeners) return
  for (const listener of listeners) listener(progress)
}

export function subscribeVideoLoadProgress(
  videoId: string,
  listener: (progress: ImageLoadProgress) => void,
) {
  const listeners = listenersById.get(videoId) ?? new Set<(progress: ImageLoadProgress) => void>()
  listeners.add(listener)
  listenersById.set(videoId, listeners)
  listener(getVideoLoadProgress(videoId))
  return () => {
    const current = listenersById.get(videoId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listenersById.delete(videoId)
  }
}

export function markVideoLoadDone(videoId: string, bytes: number | null = null) {
  setVideoLoadProgress(videoId, {
    stage: 'done',
    loadedBytes: bytes ?? 0,
    totalBytes: bytes,
    percent: 100,
    expectedBytes: bytes,
  })
}
