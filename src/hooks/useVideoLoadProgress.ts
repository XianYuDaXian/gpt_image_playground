import { useEffect, useState } from 'react'
import { createInitialImageLoadProgress, type ImageLoadProgress } from '../lib/imageLoadProgress'
import { getVideoLoadProgress, subscribeVideoLoadProgress } from '../lib/videoLoadState'

export function useVideoLoadProgress(videoId: string) {
  const [progress, setProgress] = useState<ImageLoadProgress>(
    videoId ? getVideoLoadProgress(videoId) : createInitialImageLoadProgress(),
  )

  useEffect(() => {
    if (!videoId) {
      setProgress(createInitialImageLoadProgress())
      return
    }
    return subscribeVideoLoadProgress(videoId, setProgress)
  }, [videoId])

  const isLoading = progress.stage === 'preparing'
    || progress.stage === 'downloading'
    || progress.stage === 'decoding'
  const showLoadingOverlay = progress.stage === 'preparing' || progress.stage === 'downloading'

  return { progress, isLoading, showLoadingOverlay, isError: progress.stage === 'error' }
}
