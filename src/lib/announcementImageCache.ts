import { useEffect, useState } from 'react'

const resolvedImageSrcCache = new Map<string, string>()
const loadingImageSrcCache = new Map<string, Promise<string>>()
const objectUrls = new Set<string>()

function isDirectImageSource(value: string) {
  return value.startsWith('data:') || value.startsWith('blob:')
}

function rememberResolvedSource(originalUrl: string, resolvedUrl: string) {
  resolvedImageSrcCache.set(originalUrl, resolvedUrl)
  if (resolvedUrl.startsWith('blob:')) {
    objectUrls.add(resolvedUrl)
  }
  return resolvedUrl
}

async function warmImageElement(url: string) {
  await new Promise<void>((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('图片预加载失败'))
    image.src = url
  })
}

export async function getAnnouncementImageSource(url: string) {
  const normalizedUrl = url.trim()
  if (!normalizedUrl) return ''
  const cached = resolvedImageSrcCache.get(normalizedUrl)
  if (cached) return cached
  const loading = loadingImageSrcCache.get(normalizedUrl)
  if (loading) return loading

  const task = (async () => {
    if (isDirectImageSource(normalizedUrl)) {
      return rememberResolvedSource(normalizedUrl, normalizedUrl)
    }

    try {
      const response = await fetch(normalizedUrl, { cache: 'force-cache' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      return rememberResolvedSource(normalizedUrl, objectUrl)
    } catch {
      try {
        await warmImageElement(normalizedUrl)
      } catch {
        /* 忽略。仍然回退原始地址。 */
      }
      return rememberResolvedSource(normalizedUrl, normalizedUrl)
    } finally {
      loadingImageSrcCache.delete(normalizedUrl)
    }
  })()

  loadingImageSrcCache.set(normalizedUrl, task)
  return task
}

export function preloadAnnouncementImages(urls: string[]) {
  for (const url of urls.map((item) => item.trim()).filter(Boolean)) {
    void getAnnouncementImageSource(url)
  }
}

export function useAnnouncementImageSources(urls: string[]) {
  const normalizedUrls = urls.map((item) => item.trim()).filter(Boolean)
  const [sources, setSources] = useState<Record<string, string>>(() =>
    Object.fromEntries(normalizedUrls.map((url) => [url, resolvedImageSrcCache.get(url) ?? url])),
  )

  useEffect(() => {
    let cancelled = false
    setSources((prev) => {
      const next: Record<string, string> = {}
      for (const url of normalizedUrls) {
        next[url] = prev[url] ?? resolvedImageSrcCache.get(url) ?? url
      }
      return next
    })
    for (const url of normalizedUrls) {
      void getAnnouncementImageSource(url).then((resolvedUrl) => {
        if (cancelled) return
        setSources((prev) => (prev[url] === resolvedUrl ? prev : { ...prev, [url]: resolvedUrl }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [normalizedUrls.join('\n')])

  return sources
}

export function clearAnnouncementImageCache() {
  for (const objectUrl of objectUrls) {
    URL.revokeObjectURL(objectUrl)
  }
  objectUrls.clear()
  resolvedImageSrcCache.clear()
  loadingImageSrcCache.clear()
}
