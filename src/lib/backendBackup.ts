export interface UsageCodeMediaExportSummary {
  imageCount: number
  videoCount: number
  totalBytes: number
}
export interface AdminBackupExportResult {
  ok: true
  filePath: string
  filename: string
  bytes: number
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
  filePath: string
  fileName: string
  bytes: number
  modifiedAt: string
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

export async function exportBackendBackup() {
  return readResponseJson<AdminBackupExportResult>(await fetch('/api/admin/data/export', {
    cache: 'no-store',
    credentials: 'include',
  }))
}

export async function exportUsageCodeMediaArchive() {
  const response = await fetch('/api/user/data/export-media', {
    cache: 'no-store',
    credentials: 'include',
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

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `usage-code-media-${Date.now()}.zip`
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

export async function importBackendBackup(file: File) {
  const formData = new FormData()
  formData.append('archive', file, file.name)

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
