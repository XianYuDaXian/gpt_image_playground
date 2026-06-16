export type ImageLoadStage = 'idle' | 'preparing' | 'downloading' | 'decoding' | 'done' | 'error'

export interface ImageLoadProgress {
  stage: ImageLoadStage
  loadedBytes: number
  totalBytes: number | null
  percent: number | null
  expectedBytes: number | null
}

export function createInitialImageLoadProgress(): ImageLoadProgress {
  return {
    stage: 'idle',
    loadedBytes: 0,
    totalBytes: null,
    percent: null,
    expectedBytes: null,
  }
}

export function formatByteSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}

export function resolveImageLoadPercent(progress: ImageLoadProgress) {
  if (progress.percent != null) return progress.percent
  const total = progress.totalBytes ?? progress.expectedBytes
  if (!total || total <= 0) return null
  return Math.min(99, Math.round((progress.loadedBytes / total) * 100))
}

export function getImageLoadStageLabel(progress: ImageLoadProgress) {
  const percent = resolveImageLoadPercent(progress)
  const total = progress.totalBytes ?? progress.expectedBytes

  if (progress.stage === 'preparing') return '准备加载...'
  if (progress.stage === 'downloading') {
    if (percent != null) return `下载原图 ${percent}%`
    if (total) {
      return `下载原图 ${formatByteSize(progress.loadedBytes)} / ${formatByteSize(total)}`
    }
    return `下载原图 ${formatByteSize(progress.loadedBytes)}`
  }
  if (progress.stage === 'decoding') return '解码图片...'
  if (progress.stage === 'error') return '加载失败'
  return ''
}

export function isInstantImageSrc(src: string) {
  return src.startsWith('data:') || src.startsWith('blob:')
}

export function decodeImageUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = url
  })
}

export async function fetchImageBlobWithProgress(
  url: string,
  onProgress: (progress: ImageLoadProgress) => void,
  signal?: AbortSignal,
  expectedBytes: number | null = null,
): Promise<Blob> {
  onProgress({
    stage: 'downloading',
    loadedBytes: 0,
    totalBytes: expectedBytes,
    percent: 0,
    expectedBytes,
  })

  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`图片下载失败 (${response.status})`)
  }

  const headerTotal = Number(response.headers.get('Content-Length') || 0)
  const totalBytes = Number.isFinite(headerTotal) && headerTotal > 0
    ? headerTotal
    : expectedBytes

  if (!response.body) {
    const blob = await response.blob()
    onProgress({
      stage: 'decoding',
      loadedBytes: blob.size,
      totalBytes: totalBytes ?? blob.size,
      percent: 100,
      expectedBytes,
    })
    return blob
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loadedBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    loadedBytes += value.byteLength
    const percent = totalBytes
      ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100))
      : null
    onProgress({
      stage: 'downloading',
      loadedBytes,
      totalBytes,
      percent,
      expectedBytes,
    })
  }

  const blob = new Blob(chunks as BlobPart[], { type: response.headers.get('Content-Type') || 'application/octet-stream' })
  onProgress({
    stage: 'decoding',
    loadedBytes: blob.size,
    totalBytes: totalBytes ?? blob.size,
    percent: 100,
    expectedBytes,
  })
  return blob
}