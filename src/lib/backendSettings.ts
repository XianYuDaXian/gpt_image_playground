import { normalizeBaseUrl } from './devProxy'
import type { AppSettings, VideoDurationOption, VideoResolutionOption } from '../types'
import type { MaintenanceStatus } from './backendAuth'

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
  grokApiCompat: boolean
  xaiImage2kEnabled: boolean
  responseFormatB64Json: boolean
  videoMaxResolution?: VideoResolutionOption
  videoResolutionOptions?: VideoResolutionOption[]
  videoMaxDuration?: VideoDurationOption
  videoDurationOptions?: VideoDurationOption[]
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
  showUsageCodeAliasOnTaskCard: boolean
  source?: 'env' | 'database'
}

export interface BackendProviderProfile {
  id: string
  name: string
  remarkName?: string | null
  tagColor?: string | null
  baseUrl: string
  apiKey?: string
  apiKeyMasked?: string | null
  apiKeyConfigured?: boolean
  model: string
  modelOptions?: string[] | null
  apiMode: AppSettings['apiMode']
  timeoutSeconds: number
  codexCli: boolean
  grokApiCompat: boolean
  xaiImage2kEnabled: boolean
  responseFormatB64Json: boolean
  videoMaxResolution?: VideoResolutionOption
  videoResolutionOptions?: VideoResolutionOption[]
  videoMaxDuration?: VideoDurationOption
  videoDurationOptions?: VideoDurationOption[]
  isDefault: boolean
  createdAt?: string
  updatedAt?: string
}

export interface BackendProviderOption {
  id: string
  name: string
  remarkName?: string | null
  tagColor?: string | null
  apiMode: AppSettings['apiMode']
  model: string
  modelOptions?: string[] | null
  timeoutSeconds: number
  codexCli: boolean
  grokApiCompat: boolean
  xaiImage2kEnabled: boolean
  responseFormatB64Json: boolean
  videoMaxResolution?: VideoResolutionOption
  videoResolutionOptions?: VideoResolutionOption[]
  videoMaxDuration?: VideoDurationOption
  videoDurationOptions?: VideoDurationOption[]
  isDefault: boolean
}

export interface BackendDistributionSettings {
  enabled: boolean
  maxConcurrentTasks: number
}

export interface BackendManagementOperationLog {
  id: string
  operation:
    | 'backup_export'
    | 'backup_import'
    | 'remote_reset_usage_code'
    | 'remote_reset_tasks'
    | 'remote_reset_all'
  status: 'completed' | 'failed'
  title: string
  detail: string
  createdAt: string
}

export interface BackendMediaStats {
  imageCount: number
  videoCount: number
  totalBytes: number
}

export interface BackendReminderItem {
  id: string
  enabled: boolean
  title: string
  message: string
  imageDataUrl?: string | null
  imageDataUrls: string[]
  audienceTiers: BackendUsageCodeUserTier[]
  maxDailyShows: number
  startAt: string
  endAt: string
  startTime: string
  endTime: string
  createdAt?: string
  updatedAt?: string
}

export type BackendUsageCodeUserTier = 'free' | 'paid'

export interface BackendUsageCode {
  id: string
  code: string | null
  codeRecoverable: boolean
  name: string
  userTier: BackendUsageCodeUserTier
  isEnabled: boolean
  allowedProviderProfileIds: string[] | null
  imageQuota: number | null
  usedImageCredits: number
  remainingImageCredits: number | null
  providerImageQuotas: Record<string, number> | null
  providerUsedImageCredits: Record<string, number> | null
  providerRemainingImageCredits: Record<string, number> | null
  videoQuota: number | null
  usedVideoCredits: number
  remainingVideoCredits: number | null
  providerVideoQuotas: Record<string, number> | null
  providerUsedVideoCredits: Record<string, number> | null
  providerRemainingVideoCredits: Record<string, number> | null
  taskCount: number
  outputImageCount: number
  outputVideoCount: number
  quotaEvents: Array<{
    id: number
    usageCodeId: string
    taskId: string | null
    eventType: string
    credits: number
    reason: string | null
    providerProfileId: string | null
    providerProfileName: string | null
    providerProfileTagColor?: string | null
    providerProfileApiMode?: AppSettings['apiMode'] | null
    createdAt: string
    label: string
  }>
  activityEvents: Array<{
    id: string
    taskId: string | null
    createdAt: string
    label: string
    eventType?: string | null
    credits?: number | null
    providerProfileId?: string | null
    providerProfileName?: string | null
    providerProfileTagColor?: string | null
  }>
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export type BackendUsageCodeEventTimePreset = 'today' | 'yesterday' | 'last7days' | 'last30days' | 'custom'
export type BackendUsageCodeEventBucket = 'month' | 'day' | 'hour' | '30m' | '15m' | '5m'
export type BackendUsageCodeEventCategory =
  | 'all'
  | 'create'
  | 'generate'
  | 'delete'
  | 'backup'
  | 'api_access_change'
  | 'quota_increase'
  | 'quota_decrease'
  | 'export'
  | 'distribution_change'
  | 'rename'
  | 'enable_disable'

export interface BackendUsageCodeEventSummary {
  totalEvents: number
  createCount: number
  generatedImageCount: number
  generatedVideoCount: number
  deletedTaskCount: number
  backupCount: number
  apiAccessChangeCount: number
  imageQuotaIncreasedCredits: number
  videoQuotaIncreasedCredits: number
  imageQuotaDecreasedCredits: number
  videoQuotaDecreasedCredits: number
  exportCount: number
  distributionChangeCount: number
  renameCount: number
  enableDisableCount: number
}

export interface BackendUsageCodeEventItem {
  id: string
  source: 'quota' | 'activity'
  sourceId: number
  taskId: string | null
  createdAt: string
  label: string
  eventType: string
  eventCategory: Exclude<BackendUsageCodeEventCategory, 'all'>
  credits: number | null
  providerProfileId: string | null
  providerProfileName: string | null
  providerProfileTagColor: string | null
  providerProfileApiMode?: AppSettings['apiMode'] | null
}

export interface BackendUsageCodeEventGroup {
  bucketKey: string
  bucketLabel: string
  eventCount: number
  summary: BackendUsageCodeEventSummary
  items: BackendUsageCodeEventItem[]
}

export interface BackendUsageCodeEventQueryResult {
  usageCode: {
    id: string
    name: string
    lastUsedAt: string | null
    totalEvents: number
    taskCount: number
  }
  summary: BackendUsageCodeEventSummary
  groups: BackendUsageCodeEventGroup[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
  filters: {
    timePreset: BackendUsageCodeEventTimePreset
    startAt: string | null
    endAt: string | null
    bucket: BackendUsageCodeEventBucket
    eventCategories: BackendUsageCodeEventCategory[]
    taskId: string
  }
  categories: Array<{
    value: BackendUsageCodeEventCategory
    label: string
  }>
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

function normalizeReminderItem(item: BackendReminderItem): BackendReminderItem {
  const imageDataUrls = Array.from(new Set([
    ...(item.imageDataUrls ?? []).map((value) => value.trim()).filter(Boolean),
    item.imageDataUrl?.trim() ?? '',
  ].filter(Boolean)))

  return {
    ...item,
    imageDataUrl: imageDataUrls[0] ?? null,
    imageDataUrls,
    audienceTiers: item.audienceTiers?.length ? Array.from(new Set(item.audienceTiers)) : ['free', 'paid'],
  }
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
  grokApiCompat: boolean
  xaiImage2kEnabled: boolean
  responseFormatB64Json: boolean
  videoMaxResolution?: VideoResolutionOption
  videoResolutionOptions?: VideoResolutionOption[]
  videoMaxDuration?: VideoDurationOption
  videoDurationOptions?: VideoDurationOption[]
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
  showUsageCodeAliasOnTaskCard: boolean
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
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
  showUsageCodeAliasOnTaskCard: boolean
}): Promise<Pick<
  BackendRuntimeSettings,
  | 'clearInputAfterSubmit'
  | 'persistInputOnRestart'
  | 'reuseTaskApiProfileTemporarily'
  | 'alwaysShowRetryButton'
  | 'showUsageCodeAliasOnTaskCard'
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

export async function createBackendProviderProfile(profile: Omit<BackendProviderProfile, 'id' | 'createdAt' | 'updatedAt' | 'apiKeyMasked' | 'apiKeyConfigured'>): Promise<BackendProviderProfile> {
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

export async function resetBackendRemoteData(mode: 'tasks' | 'all' | 'usage_code_tasks_only') {
  const response = await fetch('/api/admin/data/reset', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode }),
  })

  return readResponseJson<MaintenanceStatus>(response)
}

export async function fetchBackendManagementLogs() {
  const response = await fetch('/api/admin/data/management-logs', { cache: 'no-store' })
  return readResponseJson<{ items: BackendManagementOperationLog[] }>(response)
}

export async function fetchBackendMediaStats() {
  const response = await fetch('/api/admin/data/media-stats', { cache: 'no-store' })
  return readResponseJson<BackendMediaStats>(response)
}

export async function fetchBackendDistribution(): Promise<BackendDistributionSettings> {
  const response = await fetch('/api/admin/distribution', { cache: 'no-store' })
  return readResponseJson<BackendDistributionSettings>(response)
}

export async function fetchBackendReminders(): Promise<BackendReminderItem[]> {
  const response = await fetch('/api/reminders', { cache: 'no-store' })
  const payload = await readResponseJson<{ items: BackendReminderItem[] }>(response)
  return payload.items.map(normalizeReminderItem)
}

export async function fetchAdminBackendReminders(): Promise<BackendReminderItem[]> {
  const response = await fetch('/api/admin/reminders', { cache: 'no-store' })
  const payload = await readResponseJson<{ items: BackendReminderItem[] }>(response)
  return payload.items.map(normalizeReminderItem)
}

export async function saveBackendReminders(items: BackendReminderItem[]): Promise<BackendReminderItem[]> {
  const response = await fetch('/api/admin/reminders', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
  const payload = await readResponseJson<{ items: BackendReminderItem[] }>(response)
  return payload.items.map(normalizeReminderItem)
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
  userTier: BackendUsageCodeUserTier
  allowedProviderProfileIds?: string[] | null
  providerImageQuotas?: Record<string, number> | null
  providerVideoQuotas?: Record<string, number> | null
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
  patch: {
    name?: string
    userTier?: BackendUsageCodeUserTier
    isEnabled?: boolean
    allowedProviderProfileIds?: string[] | null
    providerImageQuotas?: Record<string, number> | null
    providerVideoQuotas?: Record<string, number> | null
  },
): Promise<BackendUsageCode> {
  const response = await fetch(`/api/admin/usage-codes/${encodeURIComponent(codeId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return readResponseJson<BackendUsageCode>(response)
}

export async function adjustBackendUsageCodeQuota(
  codeId: string,
  payload: {
    action: 'increase' | 'decrease'
    credits: number
    providerProfileId?: string | null
  },
): Promise<BackendUsageCode> {
  const response = await fetch(`/api/admin/usage-codes/${encodeURIComponent(codeId)}/adjust-quota`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return readResponseJson<BackendUsageCode>(response)
}

export async function deleteBackendUsageCode(codeId: string): Promise<void> {
  const response = await fetch(`/api/admin/usage-codes/${encodeURIComponent(codeId)}`, {
    method: 'DELETE',
  })
  await readResponseJson<{ ok: true }>(response)
}

export async function fetchBackendUsageCodeEvents(
  codeId: string,
  query: {
    page: number
    pageSize: number
    timePreset: BackendUsageCodeEventTimePreset
    startAt?: string | null
    endAt?: string | null
    bucket: BackendUsageCodeEventBucket
    eventCategories: BackendUsageCodeEventCategory[]
    taskId?: string
  },
): Promise<BackendUsageCodeEventQueryResult> {
  const params = new URLSearchParams()
  params.set('page', String(query.page))
  params.set('pageSize', String(query.pageSize))
  params.set('timePreset', query.timePreset)
  params.set('bucket', query.bucket)
  for (const eventCategory of query.eventCategories) {
    params.append('eventCategory', eventCategory)
  }
  if (query.startAt) params.set('startAt', query.startAt)
  if (query.endAt) params.set('endAt', query.endAt)
  if (query.taskId?.trim()) params.set('taskId', query.taskId.trim())
  const response = await fetch(`/api/admin/usage-codes/${encodeURIComponent(codeId)}/events?${params.toString()}`, {
    cache: 'no-store',
  })
  return readResponseJson<BackendUsageCodeEventQueryResult>(response)
}
