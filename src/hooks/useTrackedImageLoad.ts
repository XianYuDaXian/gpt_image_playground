import { useEffect, useRef, useState } from 'react'
import {
  getCachedLoadedImageById,
  getCachedLoadedImageSrc,
  peekCachedLoadedImageById,
  peekCachedLoadedImageSrc,
  setCachedLoadedImageById,
  setCachedLoadedImageSrc,
} from '../lib/imageLoadCache'
import {
  createInitialImageLoadProgress,
  decodeImageUrl,
  fetchImageBlobWithProgress,
  isInstantImageSrc,
  type ImageLoadProgress,
} from '../lib/imageLoadProgress'

function createDoneProgress(expectedBytes: number | null): ImageLoadProgress {
  return {
    stage: 'done',
    loadedBytes: expectedBytes ?? 0,
    totalBytes: expectedBytes,
    percent: 100,
    expectedBytes,
  }
}

function resolveInitialDisplaySrc(src: string, imageId?: string) {
  if (imageId) {
    const cachedById = getCachedLoadedImageById(imageId)
    if (cachedById) return cachedById
  }
  if (src) {
    const cachedBySrc = getCachedLoadedImageSrc(src)
    if (cachedBySrc) return cachedBySrc
  }
  return ''
}

export function useTrackedImageLoad(
  src: string,
  options?: {
    imageId?: string
    expectedBytes?: number | null
    enabled?: boolean
  },
) {
  const imageId = options?.imageId ?? ''
  const expectedBytes = options?.expectedBytes ?? null
  const enabled = options?.enabled ?? true
  const initialDisplaySrc = enabled ? resolveInitialDisplaySrc(src, imageId) : ''
  const [displaySrc, setDisplaySrc] = useState(initialDisplaySrc)
  const [progress, setProgress] = useState<ImageLoadProgress>(
    initialDisplaySrc ? createDoneProgress(expectedBytes) : createInitialImageLoadProgress(),
  )
  const objectUrlRef = useRef<string | null>(null)
  const ownsObjectUrlRef = useRef(false)

  useEffect(() => {
    const cleanupOwnedObjectUrl = () => {
      if (!objectUrlRef.current || !ownsObjectUrlRef.current) return
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
      ownsObjectUrlRef.current = false
    }

    const finish = (nextDisplaySrc: string, ownsObjectUrl: boolean) => {
      objectUrlRef.current = ownsObjectUrl ? nextDisplaySrc : null
      ownsObjectUrlRef.current = ownsObjectUrl
      if (src) setCachedLoadedImageSrc(src, nextDisplaySrc, ownsObjectUrl)
      if (imageId) setCachedLoadedImageById(imageId, nextDisplaySrc, ownsObjectUrl)
      setDisplaySrc(nextDisplaySrc)
      setProgress(createDoneProgress(expectedBytes))
    }

    if (!enabled) {
      cleanupOwnedObjectUrl()
      setDisplaySrc('')
      setProgress(createInitialImageLoadProgress())
      return
    }

    if (imageId) {
      const cachedById = getCachedLoadedImageById(imageId)
      if (cachedById) {
        cleanupOwnedObjectUrl()
        setDisplaySrc(cachedById)
        setProgress(createDoneProgress(expectedBytes))
        return
      }
    }

    if (!src) {
      cleanupOwnedObjectUrl()
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

    const cachedBySrc = getCachedLoadedImageSrc(src)
    if (cachedBySrc) {
      cleanupOwnedObjectUrl()
      if (imageId) setCachedLoadedImageById(imageId, cachedBySrc, cachedBySrc.startsWith('blob:'))
      setDisplaySrc(cachedBySrc)
      setProgress(createDoneProgress(expectedBytes))
      return
    }

    const abortController = new AbortController()
    let cancelled = false

    const run = async () => {
      cleanupOwnedObjectUrl()

      if (isInstantImageSrc(src)) {
        try {
          await decodeImageUrl(src)
          if (!cancelled) finish(src, false)
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

      setProgress({
        stage: 'downloading',
        loadedBytes: 0,
        totalBytes: expectedBytes,
        percent: 0,
        expectedBytes,
      })

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
        await decodeImageUrl(objectUrl)
        if (cancelled) return
        finish(objectUrl, true)
      } catch {
        if (cancelled || abortController.signal.aborted) return
        try {
          await decodeImageUrl(src)
          if (!cancelled) finish(src, false)
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
      if (objectUrlRef.current && ownsObjectUrlRef.current) {
        const cachedBySrc = src ? peekCachedLoadedImageSrc(src) : null
        const cachedById = imageId ? peekCachedLoadedImageById(imageId) : null
        if (cachedBySrc !== objectUrlRef.current && cachedById !== objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current)
        }
        objectUrlRef.current = null
        ownsObjectUrlRef.current = false
      }
    }
  }, [src, imageId, expectedBytes, enabled])

  const isLoading = progress.stage === 'preparing'
    || progress.stage === 'downloading'
    || progress.stage === 'decoding'

  const showLoadingOverlay = progress.stage === 'preparing' || progress.stage === 'downloading'

  return {
    displaySrc,
    isLoading,
    showLoadingOverlay,
    progress,
    isError: progress.stage === 'error',
  }
}