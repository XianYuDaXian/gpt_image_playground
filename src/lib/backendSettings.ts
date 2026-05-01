import { normalizeBaseUrl } from './devProxy'
import type { AppSettings } from '../types'

export interface BackendRuntimeSettings {
  baseUrl: string
  apiKey: string
  apiKeyMasked?: string | null
  apiKeyConfigured: boolean
  model: string
  apiMode: AppSettings['apiMode']
  timeoutSeconds: number
  codexCli: boolean
  source?: 'env' | 'database'
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

export async function fetchBackendRuntimeSettings(): Promise<BackendRuntimeSettings | null> {
  const response = await fetch('/api/runtime-settings', {
    cache: 'no-store',
  })

  if (response.status === 404) return null
  return readResponseJson<BackendRuntimeSettings>(response)
}

export async function saveBackendRuntimeSettings(settings: {
  baseUrl: string
  apiKey: string
  model: string
  apiMode: AppSettings['apiMode']
  timeoutSeconds: number
  codexCli: boolean
}): Promise<BackendRuntimeSettings> {
  const response = await fetch('/api/runtime-settings', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...settings,
      baseUrl: normalizeBaseUrl(settings.baseUrl),
    }),
  })

  return readResponseJson<BackendRuntimeSettings>(response)
}

export async function resetBackendRemoteData(mode: 'tasks' | 'all') {
  const response = await fetch('/api/admin/data/reset', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode }),
  })

  return readResponseJson<{ ok: true; mode: 'tasks' | 'all' }>(response)
}
