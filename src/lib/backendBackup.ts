import type { MaintenanceStatus } from './backendAuth'

export interface UsageCodeMediaExportSummary {
  imageCount: number
  videoCount: number
  totalBytes: number
}

export interface UsageCodeMediaExportFile {
  fileName: string
  bytes: number
  modifiedAt: string
}

interface UsageCodeMediaExportDownloadProgress {
  loadedBytes: number
  totalBytes: number | null
}
export interface AdminBackupImportResult {
  ok: true
  uploadedArchivePath: string | null
  importedTasks: number
  importedImages: number
  importedProviderProfiles?: number
  importedUsageCodes?: number
}

export interface AdminBackupImportCandidate {
  kind: 'single' | 'split'
  filePath: string
  fileName: string
  displayName?: string
  bytes: number
  modifiedAt: string
  partCount?: number
  foundPartCount?: number
  missingPartNames?: string[]
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

export async function startBackendBackupExport() {
  return readResponseJson<MaintenanceStatus>(await fetch('/api/admin/data/export/start', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
  }))
}

export async function fetchBackendBackupExportStatus() {
  return readResponseJson<MaintenanceStatus>(await fetch('/api/admin/data/export/status', {
    cache: 'no-store',
    credentials: 'include',
  }))
}

export async function startUsageCodeMediaExport() {
  return readResponseJson<MaintenanceStatus>(await fetch('/api/user/data/export-media/start', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
  }))
}

export async function fetchUsageCodeMediaExportFiles() {
  return readResponseJson<{ items: UsageCodeMediaExportFile[] }>(
    await fetch('/api/user/data/export-media/files', {
      cache: 'no-store',
      credentials: 'include',
    }),
  )
}

export async function deleteUsageCodeMediaExportFiles() {
  return readResponseJson<{ ok: true }>(
    await fetch('/api/user/data/export-media', {
      method: 'DELETE',
      cache: 'no-store',
      credentials: 'include',
    }),
  )
}

export async function markUsageCodeMediaExportDownloadCompleted(fileName: string) {
  return readResponseJson<{ ok: true }>(
    await fetch('/api/user/data/export-media/download-complete', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName }),
    }),
  )
}

export async function downloadUsageCodeMediaExportFile(
  fileName: string,
  options: {
    onProgress?: (progress: UsageCodeMediaExportDownloadProgress) => void
    signal?: AbortSignal
  } = {},
) {
  const response = await fetch(`/api/user/data/export-media/download/${encodeURIComponent(fileName)}`, {
    cache: 'no-store',
    credentials: 'include',
    signal: options.signal,
  })
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

  const totalBytes = Number(response.headers.get('content-length') ?? '')
  const expectedBytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null
  const reader = response.body?.getReader()
  if (!reader) throw new Error('浏览器不支持下载流')

  const chunks: ArrayBuffer[] = []
  let loadedBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value.slice().buffer as ArrayBuffer)
    loadedBytes += value.byteLength
    options.onProgress?.({
      loadedBytes,
      totalBytes: expectedBytes,
    })
  }

  options.onProgress?.({
    loadedBytes,
    totalBytes: expectedBytes,
  })

  const blob = new Blob(chunks, {
    type: response.headers.get('content-type') ?? 'application/octet-stream',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function fetchUsageCodeMediaExportSummary() {
  return readResponseJson<UsageCodeMediaExportSummary>(
    await fetch('/api/user/data/export-media/summary', {
      cache: 'no-store',
      credentials: 'include',
    }),
  )
}

export async function importBackendBackup(files: File[]) {
  const formData = new FormData()
  for (const file of files) {
    formData.append('archive', file, file.name)
  }

  return readResponseJson<AdminBackupImportResult>(
    await fetch('/api/admin/data/import', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    }),
  )
}

export async function fetchAdminBackupImportCandidates() {
  return readResponseJson<{ items: AdminBackupImportCandidate[] }>(
    await fetch('/api/admin/data/import-candidates', {
      cache: 'no-store',
      credentials: 'include',
    }),
  )
}

export async function importBackendBackupFromServer(archivePath: string) {
  return readResponseJson<Omit<AdminBackupImportResult, 'uploadedArchivePath'>>(
    await fetch('/api/admin/data/import-from-server', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archivePath }),
    }),
  )
}
