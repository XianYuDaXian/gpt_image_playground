import type { TaskParams, TaskRecord, VideoTaskParams } from '../types'
import type { AuthStatus } from './backendAuth'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from './canvasImage'

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

export async function fetchBackendTasks(): Promise<TaskRecord[]> {
  const response = await fetch('/api/tasks', { cache: 'no-store' })
  const payload = await readResponseJson<{ items: TaskRecord[] }>(response)
  return payload.items
}

export interface BackendTaskListResult {
  items: TaskRecord[]
  total: number
  page: number
  pageSize: number
}

export async function fetchBackendTaskPage(input: {
  page: number
  pageSize: number
  query?: string
  searchTags?: string[]
  status?: 'all' | 'running' | 'done' | 'error'
  taskType?: 'all' | 'image' | 'video'
  favorite?: boolean
  archived?: boolean
  showUsageCodeTasksForAdmin?: boolean
}): Promise<BackendTaskListResult> {
  const params = new URLSearchParams()
  params.set('page', String(input.page))
  params.set('pageSize', String(input.pageSize))
  if (input.query?.trim()) params.set('query', input.query.trim())
  for (const tag of input.searchTags ?? []) {
    const trimmedTag = tag.trim()
    if (trimmedTag) params.append('searchTag', trimmedTag)
  }
  if (input.status && input.status !== 'all') params.set('status', input.status)
  if (input.taskType && input.taskType !== 'all') params.set('taskType', input.taskType)
  if (input.favorite) params.set('favorite', '1')
  if (input.archived) params.set('archived', '1')
  if (input.showUsageCodeTasksForAdmin) params.set('showUsageCodeTasksForAdmin', '1')
  const response = await fetch(`/api/tasks?${params.toString()}`, { cache: 'no-store' })
  return readResponseJson<BackendTaskListResult>(response)
}

export async function fetchBackendTask(taskId: string): Promise<TaskRecord> {
  const response = await fetch(`/api/tasks/${taskId}`, { cache: 'no-store' })
  const payload = await readResponseJson<{ task: TaskRecord }>(response)
  return payload.task
}

export async function deleteBackendTask(taskId: string): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: 'DELETE',
  })
  await readResponseJson<{ ok: true }>(response)
}

export async function updateBackendTaskFlags(
  taskId: string,
  patch: { isFavorite?: boolean; isArchived?: boolean },
): Promise<TaskRecord> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const payload = await readResponseJson<{ task: TaskRecord }>(response)
  return payload.task
}

export async function createBackendTask(input: {
  prompt: string
  params: TaskParams
  taskType?: 'image' | 'video'
  videoParams?: VideoTaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
  providerProfileId?: string | null
  usageCodeId?: string | null
}): Promise<{ task: TaskRecord; auth?: AuthStatus }> {
  const formData = new FormData()
  formData.append('prompt', input.prompt)
  formData.append('taskType', input.taskType ?? 'image')
  formData.append('params', JSON.stringify(input.params))
  if (input.taskType === 'video' && input.videoParams) {
    formData.append('videoParams', JSON.stringify(input.videoParams))
  }
  if (input.providerProfileId) {
    formData.append('providerProfileId', input.providerProfileId)
  }
  if (input.usageCodeId) {
    formData.append('usageCodeId', input.usageCodeId)
  }

  for (let index = 0; index < input.inputImageDataUrls.length; index++) {
    const dataUrl = input.inputImageDataUrls[index]
    const blob = input.maskDataUrl && index === 0
      ? await imageDataUrlToPngBlob(dataUrl)
      : await dataUrlToBlob(dataUrl)
    const ext = blob.type.split('/')[1] || 'png'
    formData.append('input', blob, `input-${index + 1}.${ext}`)
  }

  if (input.maskDataUrl) {
    const maskBlob = await maskDataUrlToPngBlob(input.maskDataUrl)
    formData.append('mask', maskBlob, 'mask.png')
  }

  const response = await fetch('/api/tasks', {
    method: 'POST',
    body: formData,
  })
  return readResponseJson<{ task: TaskRecord; auth?: AuthStatus }>(response)
}
