type ImageLoadCacheEntry = {
  displaySrc: string
  ownsObjectUrl: boolean
}

const imageLoadCache = new Map<string, ImageLoadCacheEntry>()
const imageLoadCacheById = new Map<string, ImageLoadCacheEntry>()
const MAX_IMAGE_LOAD_CACHE_SIZE = 64

function touchCacheEntry<T>(cache: Map<string, T>, key: string, entry: T) {
  cache.delete(key)
  cache.set(key, entry)
}

function evictCacheIfNeeded(cache: Map<string, ImageLoadCacheEntry>) {
  while (cache.size > MAX_IMAGE_LOAD_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    const entry = cache.get(oldestKey)
    if (entry?.ownsObjectUrl && entry.displaySrc.startsWith('blob:')) {
      URL.revokeObjectURL(entry.displaySrc)
    }
    cache.delete(oldestKey)
  }
}

function setCacheEntry(
  cache: Map<string, ImageLoadCacheEntry>,
  key: string,
  displaySrc: string,
  ownsObjectUrl: boolean,
) {
  if (!key || !displaySrc) return
  const existing = cache.get(key)
  if (existing?.ownsObjectUrl && existing.displaySrc !== displaySrc && existing.displaySrc.startsWith('blob:')) {
    URL.revokeObjectURL(existing.displaySrc)
  }
  touchCacheEntry(cache, key, { displaySrc, ownsObjectUrl })
  evictCacheIfNeeded(cache)
}

export function peekCachedLoadedImageSrc(src: string) {
  if (!src) return null
  return imageLoadCache.get(src)?.displaySrc ?? null
}

export function getCachedLoadedImageSrc(src: string) {
  if (!src) return null
  const entry = imageLoadCache.get(src)
  if (!entry) return null
  touchCacheEntry(imageLoadCache, src, entry)
  return entry.displaySrc
}

export function setCachedLoadedImageSrc(src: string, displaySrc: string, ownsObjectUrl: boolean) {
  setCacheEntry(imageLoadCache, src, displaySrc, ownsObjectUrl)
}

export function peekCachedLoadedImageById(imageId: string) {
  if (!imageId) return null
  return imageLoadCacheById.get(imageId)?.displaySrc ?? null
}

export function getCachedLoadedImageById(imageId: string) {
  if (!imageId) return null
  const entry = imageLoadCacheById.get(imageId)
  if (!entry) return null
  touchCacheEntry(imageLoadCacheById, imageId, entry)
  return entry.displaySrc
}

export function setCachedLoadedImageById(imageId: string, displaySrc: string, ownsObjectUrl: boolean) {
  setCacheEntry(imageLoadCacheById, imageId, displaySrc, ownsObjectUrl)
}

export function releaseCachedLoadedImageSrc(src: string) {
  const entry = imageLoadCache.get(src)
  if (!entry) return
  if (entry.ownsObjectUrl && entry.displaySrc.startsWith('blob:')) {
    URL.revokeObjectURL(entry.displaySrc)
  }
  imageLoadCache.delete(src)
}

export function releaseCachedLoadedImageById(imageId: string) {
  const entry = imageLoadCacheById.get(imageId)
  if (!entry) return
  if (entry.ownsObjectUrl && entry.displaySrc.startsWith('blob:')) {
    URL.revokeObjectURL(entry.displaySrc)
  }
  imageLoadCacheById.delete(imageId)
}