export interface UsageCodeMediaExportSummary {
  imageCount: number
  videoCount: number
  totalBytes: number
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

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function exportBackendBackup() {
  const response = await fetch('/api/admin/data/export', {
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
  downloadBlob(blob, `gpt-image-playground-full-backup-${Date.now()}.zip`)
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
  downloadBlob(blob, `usage-code-media-${Date.now()}.zip`)
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

  return readResponseJson<{ ok: true; importedTasks: number; importedImages: number }>(
    await fetch('/api/admin/data/import', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    }),
  )
}
