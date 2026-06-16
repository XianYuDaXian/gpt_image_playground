import { useEffect, useRef, useState } from 'react'
import {
  createInitialImageLoadProgress,
  decodeImageUrl,
  fetchImageBlobWithProgress,
  isInstantImageSrc,
  type ImageLoadProgress,
} from '../lib/imageLoadProgress'

export function useTrackedImageLoad(
  src: string,
  options?: {
    expectedBytes?: number | null
    enabled?: boolean
  },
) {
  const expectedBytes = options?.expectedBytes ?? null
  const enabled = options?.enabled ?? true
  const [displaySrc, setDisplaySrc] = useState('')
  const [progress, setProgress] = useState<ImageLoadProgress>(createInitialImageLoadProgress)
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    const cleanupObjectUrl = () => {
      if (!objectUrlRef.current) return
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }

    if (!enabled) {
      cleanupObjectUrl()
      setDisplaySrc('')
      setProgress(createInitialImageLoadProgress())
      return
    }

    if (!src) {
      cleanupObjectUrl()
      setDisplaySrc('')
      setProgress({
        stage: 'preparing',
        loadedBytes: 0,
        totalBytes: expectedBytes,
        percent: null,
        expectedBytes,
      })
      return
    }

    const abortController = new AbortController()
    let cancelled = false

    const finish = (nextDisplaySrc: string) => {
      if (cancelled) return
      setDisplaySrc(nextDisplaySrc)
      setProgress({
        stage: 'done',
        loadedBytes: expectedBytes ?? 0,
        totalBytes: expectedBytes,
        percent: 100,
        expectedBytes,
      })
    }

    const run = async () => {
      cleanupObjectUrl()
      setDisplaySrc('')

      if (isInstantImageSrc(src)) {
        setProgress({
          stage: 'decoding',
          loadedBytes: expectedBytes ?? 0,
          totalBytes: expectedBytes,
          percent: null,
          expectedBytes,
        })
        try {
          await decodeImageUrl(src)
          finish(src)
        } catch {
          if (!cancelled) {
            setProgress({
              stage: 'error',
              loadedBytes: 0,
              totalBytes: expectedBytes,
              percent: null,
              expectedBytes,
            })
          }
        }
        return
      }

      try {
        const blob = await fetchImageBlobWithProgress(
          src,
          (update) => {
            if (!cancelled) setProgress(update)
          },
          abortController.signal,
          expectedBytes,
        )
        if (cancelled) return

        const objectUrl = URL.createObjectURL(blob)
        objectUrlRef.current = objectUrl
        setProgress({
          stage: 'decoding',
          loadedBytes: blob.size,
          totalBytes: blob.size,
          percent: 100,
          expectedBytes,
        })
        await decodeImageUrl(objectUrl)
        if (cancelled) return
        finish(objectUrl)
      } catch {
        if (cancelled || abortController.signal.aborted) return
        setProgress({
          stage: 'decoding',
          loadedBytes: 0,
          totalBytes: expectedBytes,
          percent: null,
          expectedBytes,
        })
        try {
          await decodeImageUrl(src)
          finish(src)
        } catch {
          if (!cancelled) {
            setProgress({
              stage: 'error',
              loadedBytes: 0,
              totalBytes: expectedBytes,
              percent: null,
              expectedBytes,
            })
          }
        }
      }
    }

    void run()

    return () => {
      cancelled = true
      abortController.abort()
      cleanupObjectUrl()
    }
  }, [src, expectedBytes, enabled])

  const isLoading = progress.stage === 'preparing'
    || progress.stage === 'downloading'
    || progress.stage === 'decoding'

  return {
    displaySrc,
    isLoading,
    progress,
    isError: progress.stage === 'error',
  }
}