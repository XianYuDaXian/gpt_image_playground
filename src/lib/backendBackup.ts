import { strToU8, zipSync } from 'fflate'
import type { AppSettings, TaskRecord } from '../types'

interface RuntimeSettingsBackup {
  baseUrl: string
  apiKey: string
  model: string
  apiMode: AppSettings['apiMode']
  timeoutSeconds: number
  codexCli: boolean
}

interface ExportPayload {
  runtimeSettings: RuntimeSettingsBackup | null
  tasks: TaskRecord[]
}

interface BackupImageEntry {
  id: string
  filePath: string
  mimeType: string
  width: number | null
  height: number | null
  bytes: number
  sha256: string
  createdAt: number
  dataUrl: string
}

interface BackupManifest {
  version: number
  exportedAt: string
  runtimeSettings: RuntimeSettingsBackup
  tasks: TaskRecord[]
  images: Array<Omit<BackupImageEntry, 'dataUrl'>>
}

async function readResponseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const payload = await response.json() as { message?: string }
      if (payload.message) message = payload.message
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function dataUrlToBytes(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  const mimeType = match?.[1] ?? 'image/png'
  const base64 = match?.[2] ?? dataUrl.replace(/^data:[^;]+;base64,/, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return { mimeType, bytes }
}

async function digestSha256(buffer: ArrayBuffer) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    const bytes = new Uint8Array(buffer)
    let h1 = 0x811c9dc5
    let h2 = 0x01000193

    for (let index = 0; index < bytes.length; index++) {
      const value = bytes[index] ?? 0
      h1 ^= value
      h1 = Math.imul(h1, 0x01000193)
      h2 ^= value
      h2 = Math.imul(h2, 0x27d4eb2d)
    }

    return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
  }

  const hash = await subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function extFromMimeType(mimeType: string) {
  if (mimeType.includes('jpeg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  return 'png'
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function exportBackendBackup() {
  const payload = await readResponseJson<ExportPayload>(
    await fetch('/api/admin/data/export', { cache: 'no-store' }),
  )

  if (!payload.runtimeSettings) {
    throw new Error('后端当前没有可导出的运行配置')
  }

  const imageEntries = new Map<string, BackupImageEntry>()
  for (const task of payload.tasks) {
    for (const imageId of [
      ...task.inputImageIds,
      ...(task.maskImageId ? [task.maskImageId] : []),
      ...task.outputImages,
      ...(task.outputVideos || []),
    ]) {
      if (imageEntries.has(imageId)) continue
      const imageUrl = task.imageUrlsById?.[imageId]
      if (!imageUrl) continue

      const response = await fetch(imageUrl, { cache: 'no-store' })
      if (!response.ok) {
        throw new Error(`下载备份图片失败：${imageId}`)
      }

      const blob = await response.blob()
      const arrayBuffer = await blob.arrayBuffer()
      const mimeType = blob.type || 'image/png'
      imageEntries.set(imageId, {
        id: imageId,
        filePath: `images/${imageId}.${extFromMimeType(mimeType)}`,
        mimeType,
        width: null,
        height: null,
        bytes: arrayBuffer.byteLength,
        sha256: await digestSha256(arrayBuffer),
        createdAt: task.updatedAt ?? task.createdAt,
        dataUrl: await blobToDataUrl(new Blob([arrayBuffer], { type: mimeType })),
      })
    }
  }

  const manifest: BackupManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    runtimeSettings: payload.runtimeSettings,
    tasks: payload.tasks,
    images: Array.from(imageEntries.values()).map(({ dataUrl: _dataUrl, ...image }) => image),
  }

  const zipFiles: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
  }

  for (const image of imageEntries.values()) {
    zipFiles[image.filePath] = dataUrlToBytes(image.dataUrl).bytes
  }

  const zipped = zipSync(zipFiles, { level: 6 })
  downloadBlob(
    new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' }),
    `gpt-image-playground-backup-${Date.now()}.zip`,
  )
}

export async function importBackendBackup(file: File) {
  const formData = new FormData()
  formData.append('archive', file, file.name)

  return readResponseJson<{ ok: true; importedTasks: number; importedImages: number }>(
    await fetch('/api/admin/data/import', {
      method: 'POST',
      body: formData,
    }),
  )
}
