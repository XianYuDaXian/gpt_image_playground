import { normalizeBaseUrl } from './devProxy'
import type { AppSettings } from '../types'

export interface BackendRuntimeSettings {
  id?: string
  name?: string
  baseUrl: string
  apiKey: string
  apiKeyMasked?: string | null
  apiKeyConfigured: boolean
  model: string
  apiMode: AppSettings['apiMode']
  timeoutSeconds: number
  codexCli: boolean
  responseFormatB64Json: boolean
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
  source?: 'env' | 'database'
}

export interface BackendProviderProfile {
  id: string
  name: string
  baseUrl: string
  apiKey?: string
  apiKeyMasked?: string | null
  apiKeyConfigured?: boolean
  model: string
  apiMode: AppSettings['apiMode']
  timeoutSeconds: number
  responseFormatB64Json: boolean
  isDefault: boolean
  createdAt?: string
  updatedAt?: string
}

export interface BackendProviderOption {
  id: string
  name: string
  isDefault: boolean
}

export interface BackendDistributionSettings {
  enabled: boolean
  maxConcurrentTasks: number
}

export interface BackendUsageCode {
  id: string
  code: string | null
  codeRecoverable: boolean
  name: string
  isEnabled: boolean
  imageQuota: number | null
  usedImageCredits: number
  remainingImageCredits: number | null
  taskCount: number
  outputImageCount: number
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
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
  responseFormatB64Json: boolean
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
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

export async function saveBackendRuntimePreferences(settings: {
  codexCli: boolean
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
}): Promise<Pick<
  BackendRuntimeSettings,
  | 'codexCli'
  | 'clearInputAfterSubmit'
  | 'persistInputOnRestart'
  | 'reuseTaskApiProfileTemporarily'
  | 'alwaysShowRetryButton'
>> {
  const response = await fetch('/api/runtime-preferences', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(settings),
  })

  return readResponseJson(response)
}

export async function fetchBackendProviderProfiles(): Promise<BackendProviderProfile[]> {
  const response = await fetch('/api/admin/provider-profiles', { cache: 'no-store' })
  return readResponseJson<BackendProviderProfile[]>(response)
}

export async function fetchBackendProviderOptions(): Promise<BackendProviderOption[]> {
  const response = await fetch('/api/provider-options', { cache: 'no-store' })
  const payload = await readResponseJson<{ items: BackendProviderOption[] }>(response)
  return payload.items
}

export async function createBackendProviderProfile(profile: Omit<BackendProviderProfile, 'createdAt' | 'updatedAt' | 'apiKeyMasked' | 'apiKeyConfigured'>): Promise<BackendProviderProfile> {
  const response = await fetch('/api/admin/provider-profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...profile,
      baseUrl: normalizeBaseUrl(profile.baseUrl),
    }),
  })
  return readResponseJson<BackendProviderProfile>(response)
}

export async function updateBackendProviderProfile(profile: BackendProviderProfile): Promise<BackendProviderProfile> {
  const response = await fetch(`/api/admin/provider-profiles/${encodeURIComponent(profile.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...profile,
      baseUrl: normalizeBaseUrl(profile.baseUrl),
    }),
  })
  return readResponseJson<BackendProviderProfile>(response)
}

export async function deleteBackendProviderProfile(profileId: string): Promise<void> {
  const response = await fetch(`/api/admin/provider-profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  })
  await readResponseJson<{ ok: true }>(response)
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

export async function fetchBackendDistribution(): Promise<BackendDistributionSettings> {
  const response = await fetch('/api/admin/distribution', { cache: 'no-store' })
  return readResponseJson<BackendDistributionSettings>(response)
}

export async function saveBackendDistribution(settings: BackendDistributionSettings): Promise<BackendDistributionSettings> {
  const response = await fetch('/api/admin/distribution', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  return readResponseJson<BackendDistributionSettings>(response)
}

export async function fetchBackendUsageCodes(): Promise<BackendUsageCode[]> {
  const response = await fetch('/api/admin/usage-codes', { cache: 'no-store' })
  const payload = await readResponseJson<{ items: BackendUsageCode[] }>(response)
  return payload.items
}

export async function createBackendUsageCode(input: {
  name: string
  imageQuota: number | null
}): Promise<{ code: string; item: BackendUsageCode }> {
  const response = await fetch('/api/admin/usage-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return readResponseJson<{ code: string; item: BackendUsageCode }>(response)
}

export async function updateBackendUsageCode(
  codeId: string,
  patch: { name?: string; isEnabled?: boolean; imageQuota?: number | null },
): Promise<BackendUsageCode> {
  const response = await fetch(`/api/admin/usage-codes/${encodeURIComponent(codeId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return readResponseJson<BackendUsageCode>(response)
}

export async function deleteBackendUsageCode(codeId: string): Promise<void> {
  const response = await fetch(`/api/admin/usage-codes/${encodeURIComponent(codeId)}`, {
    method: 'DELETE',
  })
  await readResponseJson<{ ok: true }>(response)
}
