import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { normalizeBaseUrl } from '../lib/devProxy'
import {
  fetchAdminBackendReminders,
  fetchBackendReminders,
  createBackendProviderProfile,
  createBackendUsageCode,
  deleteBackendProviderProfile,
  deleteBackendUsageCode,
  saveBackendReminders,
  fetchBackendDistribution,
  fetchBackendProviderOptions,
  fetchBackendProviderProfiles,
  fetchBackendRuntimeSettings,
  fetchBackendUsageCodeEvents,
  fetchBackendUsageCodes,
  fetchBackendManagementLogs,
  fetchBackendMediaStats,
  resetBackendRemoteData,
  saveBackendRuntimePreferences,
  saveBackendDistribution,
  updateBackendProviderProfile,
  updateBackendUsageCode,
  type BackendReminderItem,
  type BackendDistributionSettings,
  type BackendManagementOperationLog,
  type BackendMediaStats,
  type BackendProviderOption,
  type BackendProviderProfile,
  type BackendUsageCodeEventBucket,
  type BackendUsageCodeEventCategory,
  type BackendUsageCodeEventGroup,
  type BackendUsageCodeEventQueryResult,
  type BackendUsageCodeEventSummary,
  type BackendUsageCodeEventTimePreset,
  type BackendUsageCodeUserTier,
  type BackendUsageCode,
} from '../lib/backendSettings'
import { isCompletedReminderUnread, markCompletedReminderSeen } from '../lib/announcement'
import {
  fetchAdminBackupImportCandidates,
  deleteUsageCodeMediaExportFiles,
  fetchUsageCodeMediaExportFiles,
  startBackendBackupExport,
  startUsageCodeMediaExport,
  downloadUsageCodeMediaExportFile,
  fetchUsageCodeMediaExportSummary,
  importBackendBackup,
  importBackendBackupFromServer,
  markUsageCodeMediaExportDownloadCompleted,
  type AdminBackupImportCandidate,
  type UsageCodeMediaExportFile,
  type UsageCodeMediaExportSummary,
} from '../lib/backendBackup'
import { addSessionUsageCode, fetchAuthStatus } from '../lib/backendAuth'
import { fetchBackendTasks } from '../lib/backendTasks'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { renderTextWithLinks } from '../lib/linkify'
import { useStore, clearAllData, clearLocalTaskCache } from '../store'
import { DEFAULT_IMAGES_MODEL, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, type AppSettings } from '../types'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import Select from './Select'
import ProviderProfileTag, { getProviderProfileDisplayName } from './ProviderProfileTag'
import HelpModal from './HelpModal'

type SettingsTab = 'habits' | 'api' | 'data' | 'distribution'
type UsageCodeEventQueryDraft = {
  timePreset: BackendUsageCodeEventTimePreset
  startAt: string
  endAt: string
  bucket: BackendUsageCodeEventBucket
  eventCategories: BackendUsageCodeEventCategory[]
  taskId: string
}

type UsageCodeEventModalState = {
  code: BackendUsageCode
  query: UsageCodeEventQueryDraft
  result: BackendUsageCodeEventQueryResult | null
  loading: boolean
  expandedGroupKeys: string[]
}

type ReminderAudienceValue = 'all' | BackendUsageCodeUserTier

function createDateRange(days: number) {
  const now = new Date()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - days)
  return {
    startAt: toLocalDateTimeInputValue(start),
    endAt: toLocalDateTimeInputValue(now),
  }
}

function createDefaultUsageCodeEventQuery(timePreset: BackendUsageCodeEventTimePreset = 'today'): UsageCodeEventQueryDraft {
  if (timePreset === 'yesterday') {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(today)
    start.setDate(start.getDate() - 1)
    const end = new Date(today)
    return {
      timePreset,
      startAt: toLocalDateTimeInputValue(start),
      endAt: toLocalDateTimeInputValue(end),
      bucket: 'hour',
      eventCategories: ['all'],
      taskId: '',
    }
  }
  if (timePreset === 'last7days') {
    return {
      timePreset,
      ...createDateRange(6),
      bucket: 'day',
      eventCategories: ['all'],
      taskId: '',
    }
  }
  if (timePreset === 'last30days') {
    return {
      timePreset,
      ...createDateRange(29),
      bucket: 'day',
      eventCategories: ['all'],
      taskId: '',
    }
  }
  if (timePreset === 'custom') {
    return {
      timePreset,
      ...createDateRange(0),
      bucket: 'hour',
      eventCategories: ['all'],
      taskId: '',
    }
  }
  return {
    timePreset: 'today',
    ...createDateRange(0),
    bucket: 'hour',
    eventCategories: ['all'],
    taskId: '',
  }
}

function getDefaultBucketForPreset(timePreset: BackendUsageCodeEventTimePreset): BackendUsageCodeEventBucket {
  if (timePreset === 'last7days' || timePreset === 'last30days') return 'day'
  return 'hour'
}

function createEmptyProfile(): BackendProviderProfile {
  return {
    id: '',
    name: '新 API 配置',
    remarkName: '',
    baseUrl: DEFAULT_SETTINGS.baseUrl,
    apiKey: '',
    apiKeyMasked: null,
    apiKeyConfigured: false,
    model: DEFAULT_IMAGES_MODEL,
    modelOptions: [DEFAULT_IMAGES_MODEL],
    apiMode: 'images',
    timeoutSeconds: DEFAULT_SETTINGS.timeout,
    codexCli: false,
    grokApiCompat: false,
    xaiImage2kEnabled: false,
    responseFormatB64Json: false,
    videoMaxResolution: '480p',
    videoMaxDuration: 6,
    isDefault: false,
  }
}

function createCopiedProfile(profile: BackendProviderProfile): BackendProviderProfile {
  return {
    ...profile,
    id: '',
    name: `${profile.name} 副本`,
    remarkName: profile.remarkName ?? '',
    apiKey: '',
    apiKeyMasked: profile.apiKeyMasked ?? null,
    apiKeyConfigured: profile.apiKeyConfigured ?? false,
    modelOptions: profile.modelOptions?.length ? [...profile.modelOptions] : [profile.model],
    isDefault: false,
  }
}

function toLocalDateTimeInputValue(value: Date) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function createReminderId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function createEmptyReminder(): BackendReminderItem {
  const now = new Date()
  return {
    id: createReminderId(),
    enabled: false,
    title: '数据备份提醒',
    message: '',
    imageDataUrl: null,
    imageDataUrls: [],
    audienceTiers: ['free', 'paid'],
    maxDailyShows: 1,
    startAt: toLocalDateTimeInputValue(now),
    endAt: toLocalDateTimeInputValue(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
    startTime: '09:00',
    endTime: '21:00',
  }
}

const COMPLETED_MAINTENANCE_CARD_MS = 10_000

function normalizeReminderForEditor(item: BackendReminderItem): BackendReminderItem {
  const imageDataUrls = Array.from(new Set([
    ...(item.imageDataUrls ?? []).map((value) => value.trim()).filter(Boolean),
    item.imageDataUrl?.trim() ?? '',
  ].filter(Boolean)))
  return {
    ...item,
    imageDataUrl: imageDataUrls[0] ?? null,
    imageDataUrls,
    audienceTiers: item.audienceTiers?.length ? Array.from(new Set(item.audienceTiers)) : ['free', 'paid'],
    startAt: item.startAt.length > 16 ? toLocalDateTimeInputValue(new Date(item.startAt)) : item.startAt,
    endAt: item.endAt.length > 16 ? toLocalDateTimeInputValue(new Date(item.endAt)) : item.endAt,
  }
}

function getReminderAudienceValue(item: BackendReminderItem): ReminderAudienceValue {
  const tiers = new Set(item.audienceTiers?.length ? item.audienceTiers : ['free', 'paid'])
  if (tiers.has('free') && tiers.has('paid')) return 'all'
  return tiers.has('paid') ? 'paid' : 'free'
}

function getReminderAudienceTiers(value: ReminderAudienceValue): BackendUsageCodeUserTier[] {
  if (value === 'all') return ['free', 'paid']
  return [value]
}

function formatReminderAudience(item: BackendReminderItem) {
  const value = getReminderAudienceValue(item)
  if (value === 'all') return '全部用户'
  return value === 'free' ? '免费用户' : '付费用户'
}

function formatUsageCodeUserTier(value: BackendUsageCodeUserTier) {
  return value === 'free' ? '免费用户' : '付费用户'
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

type UsageCodeDownloadItemState = {
  status: 'idle' | 'downloading' | 'paused' | 'success' | 'error'
  loadedBytes: number
  totalBytes: number | null
}

function isReminderImageUrl(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeReminderImageUrls(values: string[]) {
  return Array.from(new Set(
    values
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && isReminderImageUrl(value)),
  )).slice(0, 16)
}

function formatReminderImageUrls(value: string[]) {
  return value.join('\n')
}

function createReminderImageUrlDraftMap(items: BackendReminderItem[]) {
  return Object.fromEntries(
    items.map((item) => [item.id, formatReminderImageUrls(item.imageDataUrls ?? [])]),
  )
}

function toServerDateTimeValue(value: string) {
  return new Date(value).toISOString()
}

function Switch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-1'}`} />
    </button>
  )
}

function PreferenceRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-start justify-between gap-4 py-3">
      <span>
        <span className="block text-sm font-medium text-gray-800 dark:text-gray-100">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-gray-500 dark:text-gray-400">{description}</span>
      </span>
      <Switch checked={checked} onChange={onChange} />
    </label>
  )
}

function ClearButton({ onClear, label }: { onClear: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-white/[0.08] dark:hover:text-gray-300"
      aria-label={label}
      title={label}
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  )
}

function ClearableInput({
  value,
  onClear,
  className = '',
  clearLabel = '清空输入',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  value: string | number
  onClear: () => void
  clearLabel?: string
}) {
  const hasValue = String(value).length > 0
  const inputClassName = /\bpr-\d+/.test(className) ? className : `${className} pr-10`
  return (
    <div className="relative min-w-0 flex-1">
      <input value={value} className={inputClassName} {...props} />
      {hasValue && <ClearButton onClear={onClear} label={clearLabel} />}
    </div>
  )
}

function ClearableTextarea({
  value,
  onClear,
  className = '',
  clearLabel = '清空输入',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  value: string
  onClear: () => void
  clearLabel?: string
}) {
  const hasValue = value.length > 0
  const textareaClassName = /\bpr-\d+/.test(className) ? className : `${className} pr-10`
  return (
    <div className="relative">
      <textarea value={value} className={textareaClassName} {...props} />
      {hasValue && <ClearButton onClear={onClear} label={clearLabel} />}
    </div>
  )
}

function VideoCapabilitySlider({
  title,
  value,
  labels,
  suffix = '',
  onChange,
}: {
  title: string
  value: string
  labels: string[]
  suffix?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{title}</span>
      </div>
      <div role="radiogroup" aria-label={title} className="inline-flex h-10 shrink-0 items-center rounded-xl border border-gray-200/60 bg-white/70 p-1 text-sm shadow-sm dark:border-white/[0.08] dark:bg-white/[0.03]">
        {labels.map((label) => {
          const selected = label === value
          return (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(label)}
              className={`inline-flex h-full min-w-12 items-center justify-center rounded-lg px-3 leading-none transition ${
                selected
                  ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-300 dark:hover:text-white'
              }`}
            >
              {label}{suffix}
            </button>
          )
        })}
      </div>
    </label>
  )
}

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const authStatus = useStore((s) => s.authStatus)
  const setAuthStatus = useStore((s) => s.setAuthStatus)
  const setTasks = useStore((s) => s.setTasks)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [profiles, setProfiles] = useState<BackendProviderProfile[]>([])
  const [providerOptions, setProviderOptions] = useState<BackendProviderOption[]>([])
  const [profileDraft, setProfileDraft] = useState<BackendProviderProfile>(createEmptyProfile())
  const [distribution, setDistribution] = useState<BackendDistributionSettings>({ enabled: false, maxConcurrentTasks: 2 })
  const [reminderDrafts, setReminderDrafts] = useState<BackendReminderItem[]>([])
  const [reminderImageUrlDrafts, setReminderImageUrlDrafts] = useState<Record<string, string>>({})
  const [usageCodes, setUsageCodes] = useState<BackendUsageCode[]>([])
  const [newCodeName, setNewCodeName] = useState('新使用码')
  const [newCodeUserTier, setNewCodeUserTier] = useState<BackendUsageCodeUserTier>('free')
  const [newCodeAllowedProviderProfileIds, setNewCodeAllowedProviderProfileIds] = useState<string[] | null>([])
  const [newCodeProviderImageQuotas, setNewCodeProviderImageQuotas] = useState<Record<string, string>>({})
  const [newCodeProviderVideoQuotas, setNewCodeProviderVideoQuotas] = useState<Record<string, string>>({})
  const [latestPlainCode, setLatestPlainCode] = useState('')
  const [usageCodeProviderImageQuotaDrafts, setUsageCodeProviderImageQuotaDrafts] = useState<Record<string, Record<string, string>>>({})
  const [usageCodeProviderVideoQuotaDrafts, setUsageCodeProviderVideoQuotaDrafts] = useState<Record<string, Record<string, string>>>({})
  const [usageCodeSearchQuery, setUsageCodeSearchQuery] = useState('')
  const [expandedUsageCodeIds, setExpandedUsageCodeIds] = useState<string[]>([])
  const [expandedReminderIds, setExpandedReminderIds] = useState<string[]>([])
  const [addCodeValue, setAddCodeValue] = useState('')
  const [activeTab, setActiveTab] = useState<SettingsTab>('habits')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isClearingRemote, setIsClearingRemote] = useState(false)
  const [isSavingReminders, setIsSavingReminders] = useState(false)
  const [usageCodeExportSummary, setUsageCodeExportSummary] = useState<UsageCodeMediaExportSummary | null>(null)
  const [usageCodeExportFiles, setUsageCodeExportFiles] = useState<UsageCodeMediaExportFile[]>([])
  const [usageCodeDownloadStates, setUsageCodeDownloadStates] = useState<Record<string, UsageCodeDownloadItemState>>({})
  const [isDeletingUsageCodeExportFiles, setIsDeletingUsageCodeExportFiles] = useState(false)
  const [importCandidates, setImportCandidates] = useState<AdminBackupImportCandidate[]>([])
  const [showImportCandidates, setShowImportCandidates] = useState(false)
  const [managementLogs, setManagementLogs] = useState<BackendManagementOperationLog[]>([])
  const [mediaStats, setMediaStats] = useState<BackendMediaStats | null>(null)
  const [maintenanceCardNow, setMaintenanceCardNow] = useState(() => Date.now())
  const [usageCodeEventModal, setUsageCodeEventModal] = useState<UsageCodeEventModalState | null>(null)
  const [isUsageCodeEventCategoryMenuOpen, setIsUsageCodeEventCategoryMenuOpen] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)
  const settingsPanelRef = useRef<HTMLDivElement>(null)
  const usageCodeEventPanelRef = useRef<HTMLDivElement>(null)
  const usageCodeEventCategoryMenuRef = useRef<HTMLDivElement>(null)
  const usageCodeDownloadAbortControllersRef = useRef<Record<string, AbortController>>({})
  const usageCodeDownloadStopActionsRef = useRef<Record<string, 'pause' | 'cancel' | null>>({})

  const getDefaultModelForMode = (apiMode: AppSettings['apiMode']) =>
    apiMode === 'videos' ? 'grok-imagine-video' : apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL

  const selectedProfileId = profileDraft.id || '__new__'
  const isAdmin = authStatus?.role === 'admin'
  const backupState = authStatus?.maintenance
  const isUsageCodeExportActive = backupState?.operation === 'usage_code_media_export' && backupState.active
  const shouldShowUsageCodeExportStatus = !isAdmin && backupState?.operation === 'usage_code_media_export' && backupState.phase !== 'idle'
  const shouldShowMaintenanceCard = Boolean(
    backupState
    && backupState.phase !== 'idle'
    && (
      backupState.active
      || backupState.phase === 'failed'
      || (
        backupState.phase === 'completed'
        && backupState.finishedAt
        && maintenanceCardNow - new Date(backupState.finishedAt).getTime() <= COMPLETED_MAINTENANCE_CARD_MS
      )
    ),
  )
  const userUsageCodes = authStatus?.usageCodes ?? []
  const activeUsageCodeDownloadCount = Object.values(usageCodeDownloadStates).filter((item) => item.status === 'downloading').length
  const hasPendingUsageCodeDownload = Object.values(usageCodeDownloadStates).some((item) => item.status === 'downloading' || item.status === 'paused')
  const getAdminProviderName = (profile: Pick<BackendProviderProfile, 'name' | 'remarkName'> | Pick<BackendProviderOption, 'name' | 'remarkName'>) =>
    getProviderProfileDisplayName({
      name: profile.name,
      remarkName: profile.remarkName,
      preferRemarkName: isAdmin,
    })

  const getProviderDistributedRemaining = (
    profileId: string,
    apiMode: AppSettings['apiMode'],
  ) => usageCodes.reduce((sum, code) => {
    const isVideoProvider = apiMode === 'videos'
    const remaining = isVideoProvider
      ? code.providerRemainingVideoCredits?.[profileId]
      : code.providerRemainingImageCredits?.[profileId]
    return sum + Math.max(0, remaining ?? 0)
  }, 0)
  const hasUnreadEndedReminders = useMemo(
    () => reminderDrafts.some((item) => isCompletedReminderUnread(item)),
    [reminderDrafts, expandedReminderIds],
  )
  const orderedReminderDrafts = useMemo(() => {
    const now = Date.now()
    const activeSavedItems = reminderDrafts
      .filter((item) => (item.createdAt || item.updatedAt) && new Date(item.endAt).getTime() > now)
      .sort((left, right) => new Date(right.updatedAt ?? right.startAt).getTime() - new Date(left.updatedAt ?? left.startAt).getTime())
    const endedSavedItems = reminderDrafts
      .filter((item) => (item.createdAt || item.updatedAt) && new Date(item.endAt).getTime() <= now)
      .sort((left, right) => new Date(right.updatedAt ?? right.startAt).getTime() - new Date(left.updatedAt ?? left.startAt).getTime())
    const newDraftItems = reminderDrafts
      .filter((item) => !item.createdAt && !item.updatedAt)
      .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime())

    return [...activeSavedItems, ...endedSavedItems, ...newDraftItems]
  }, [reminderDrafts])

  useEffect(() => {
    if (!showSettings) return
    document.body.dataset.settingsModalActive = '1'
    return () => {
      delete document.body.dataset.settingsModalActive
    }
  }, [showSettings])
  usePreventBackgroundScroll(showSettings || Boolean(usageCodeEventModal), [settingsPanelRef, usageCodeEventPanelRef])
  const filteredUsageCodes = useMemo(() => {
    const query = usageCodeSearchQuery.trim().toLowerCase()
    if (!query) return usageCodes
    return usageCodes.filter((code) =>
      [code.name, code.code ?? '', formatUsageCodeUserTier(code.userTier)]
        .join(' ')
        .toLowerCase()
        .includes(query),
    )
  }, [usageCodeSearchQuery, usageCodes])

  const calculateQuotaExpression = (rawValue: string, baseValue: number) => {
    const value = rawValue.trim().replace(/\s+/g, '')
    if (value === '') return null
    if (!/^[+-]?\d+(?:[+-]\d+)*$/.test(value)) return undefined
    const startsWithOperator = value.startsWith('+') || value.startsWith('-')
    const matches = value.match(/[+-]?\d+/g) ?? []
    const result = matches.reduce((sum, part) => sum + Number(part), startsWithOperator ? baseValue : 0)
    if (!Number.isInteger(result) || result < 0) return undefined
    return result
  }

  const getQuotaEditorProfiles = (
    allowedProviderProfileIds: string[] | null | undefined,
    quotaType: 'image' | 'video',
  ) => {
    if (allowedProviderProfileIds == null) {
      return profiles.filter((profile) => (quotaType === 'video' ? profile.apiMode === 'videos' : profile.apiMode !== 'videos'))
    }
    if (allowedProviderProfileIds.length > 0) {
      return profiles.filter((profile) =>
        allowedProviderProfileIds.includes(profile.id)
        && (quotaType === 'video' ? profile.apiMode === 'videos' : profile.apiMode !== 'videos'),
      )
    }
    return []
  }

  const formatQuotaValue = (value: number | null | undefined) => {
    if (value == null) return '不限'
    if (value === 0) return '禁用'
    return String(value)
  }

  const getUsageCodeProviderStats = (code: BackendUsageCode, profile: BackendProviderProfile) => {
    const isVideoProfile = profile.apiMode === 'videos'
    const usedCount = isVideoProfile
      ? code.providerUsedVideoCredits?.[profile.id] ?? 0
      : code.providerUsedImageCredits?.[profile.id] ?? 0
    const totalCount = isVideoProfile
      ? code.providerVideoQuotas?.[profile.id] ?? null
      : code.providerImageQuotas?.[profile.id] ?? null
    const availableCount = isVideoProfile
      ? code.providerRemainingVideoCredits?.[profile.id] ?? null
      : code.providerRemainingImageCredits?.[profile.id] ?? null
    return {
      usedCount,
      totalCount,
      totalText: formatQuotaValue(totalCount),
      availableCount,
      availableText: formatQuotaValue(availableCount),
      availableDetailText: String(availableCount ?? 0),
    }
  }

  const getLegacyImageUsageCount = (code: BackendUsageCode) => {
    const providerUsedTotal = Object.values(code.providerUsedImageCredits ?? {}).reduce((sum, value) => sum + value, 0)
    return Math.max(0, code.usedImageCredits - providerUsedTotal)
  }

  const formatBytes = (bytes: number) => {
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

  const formatLocalDateTime = (value: string) =>
    new Date(value).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })

  const formatActivityEventTagText = (event: BackendUsageCode['activityEvents'][number]) => {
    if (!event.providerProfileName || event.credits == null) return null
    const isIncrease = event.eventType === 'admin_increase' || event.eventType === 'video_admin_increase' || event.eventType === 'refund' || event.eventType === 'video_refund'
    const isDecrease = event.eventType === 'admin_decrease' || event.eventType === 'video_admin_decrease' || event.eventType === 'reserve' || event.eventType === 'video_reserve'
    if (!isIncrease && !isDecrease) return null
    return `${event.providerProfileName}：${isIncrease ? '+' : '-'}${event.credits}`
  }

  const getEnabledProfilesForUsageCode = (allowedProviderProfileIds: string[] | null | undefined) => {
    if (allowedProviderProfileIds == null) return profiles
    if (allowedProviderProfileIds.length === 0) return []
    return allowedProviderProfileIds
      .map((id) => profiles.find((profile) => profile.id === id))
      .filter((profile): profile is BackendProviderProfile => Boolean(profile))
  }

  const findProfileByName = (name: string) => profiles.find((profile) => profile.name === name) ?? null

  const renderProviderOptionLabel = (
    profile: Pick<BackendProviderProfile, 'id' | 'name' | 'remarkName' | 'tagColor' | 'apiMode' | 'isDefault'>,
    options: { showDistributedRemaining?: boolean; showUserRemaining?: boolean } = {},
  ) => {
    const distributedRemaining = options.showDistributedRemaining
      ? getProviderDistributedRemaining(profile.id, profile.apiMode)
      : null
    const userRemaining = options.showUserRemaining
      ? userUsageCodes.reduce((sum, code) => {
          const remaining = profile.apiMode === 'videos'
            ? code.providerRemainingVideoCredits?.[profile.id]
            : code.providerRemainingImageCredits?.[profile.id]
          return sum + Math.max(0, remaining ?? 0)
        }, 0)
      : null
    return (
      <div className="flex min-w-0 items-center justify-between gap-2">
        <ProviderProfileTag
          name={profile.name}
          remarkName={profile.remarkName}
          preferRemarkName={isAdmin}
          colorKey={profile.id}
          tagColor={profile.tagColor}
          apiMode={profile.apiMode}
          isDefault={profile.isDefault}
        />
        {distributedRemaining != null && (
          <span className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400">
            未用 {distributedRemaining}
          </span>
        )}
        {userRemaining != null && (
          <span className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400">
            剩余 {userRemaining}
          </span>
        )}
      </div>
    )
  }

  const parseUsageCodeAccessLabel = (label: string) => {
    const normalizedLabel = label.trim()
    if (!normalizedLabel) return { kind: 'none' as const, names: [] as string[] }
    if (normalizedLabel === '全部 API') return { kind: 'all' as const, names: [] as string[] }
    if (normalizedLabel === '未匹配 API') return { kind: 'unknown' as const, names: [] as string[] }
    return {
      kind: 'profiles' as const,
      names: normalizedLabel.split('、').map((item) => item.trim()).filter(Boolean),
    }
  }

  const getUsageCodeAccessTagItems = (label: string) => {
    const parsed = parseUsageCodeAccessLabel(label)
    if (parsed.kind === 'all') {
      return [{
        key: 'all',
        name: '全部 API',
        colorKey: 'all-api',
        tagColor: null,
      }]
    }
    if (parsed.kind === 'unknown') {
      return [{
        key: 'unknown',
        name: '未匹配 API',
        colorKey: 'unknown-api',
        tagColor: null,
      }]
    }
    return parsed.names.map((name) => {
      const profile = findProfileByName(name)
      return {
        key: profile?.id ?? name,
        name,
        colorKey: profile?.id ?? name,
        tagColor: profile?.tagColor ?? null,
      }
    })
  }

  const parseUsageCodeAccessActivity = (event: BackendUsageCode['activityEvents'][number]) => {
    if (event.eventType === 'usage_code_created') {
      const match = event.label.match(/可用 API：(.+)$/)
      if (!match) return null
      return {
        kind: 'created' as const,
        enabledLabel: match[1]?.trim() ?? '',
        disabledLabel: '',
      }
    }
    if (event.eventType === 'usage_code_allowed_apis_changed') {
      const match = event.label.match(/^管理员调整可用 API：(.+?) -> (.+)$/)
      if (!match) return null
      const previousLabel = match[1]?.trim() ?? ''
      const nextLabel = match[2]?.trim() ?? ''
      const previous = parseUsageCodeAccessLabel(previousLabel)
      const next = parseUsageCodeAccessLabel(nextLabel)
      const nextNameSet = new Set(next.names)
      let disabledNames: string[] = []
      if (previous.kind === 'profiles') {
        disabledNames = previous.names.filter((name) => !nextNameSet.has(name))
      } else if (previous.kind === 'all' && next.kind !== 'all') {
        disabledNames = profiles
          .map((profile) => profile.name)
          .filter((name) => !nextNameSet.has(name))
      }
      return {
        kind: 'changed' as const,
        enabledLabel: nextLabel,
        disabledLabel: disabledNames.join('、'),
      }
    }
    return null
  }

  const renderUsageCodeAccessTags = (label: string, disabled = false) => {
    const items = getUsageCodeAccessTagItems(label)
    if (!items.length) {
      return (
        <span className="text-xs text-gray-400 dark:text-gray-500">
          无
        </span>
      )
    }
    return items.map((item) => (
      <ProviderProfileTag
        key={`${disabled ? 'off' : 'on'}-${item.key}-${item.name}`}
        name={item.name}
        text={item.name}
        colorKey={item.colorKey}
        tagColor={item.tagColor}
        includeMode={false}
        includeDefault={false}
        disabled={disabled}
        crossed={disabled}
        className="max-w-[10rem]"
      />
    ))
  }

  const categoryOptions = useMemo(() => (
    usageCodeEventModal?.result?.categories ?? [
      { value: 'all' as const, label: '全部事件' },
      { value: 'create' as const, label: '创建使用码' },
      { value: 'generate' as const, label: '生成' },
      { value: 'delete' as const, label: '删除' },
      { value: 'backup' as const, label: '备份' },
      { value: 'api_access_change' as const, label: '管理员调整 API' },
      { value: 'quota_increase' as const, label: '管理员加额' },
      { value: 'quota_decrease' as const, label: '额度扣减' },
      { value: 'export' as const, label: '导出' },
      { value: 'distribution_change' as const, label: '分发设置' },
      { value: 'rename' as const, label: '重命名' },
      { value: 'enable_disable' as const, label: '启用与禁用' },
    ]
  ), [usageCodeEventModal?.result?.categories])

  const executeUsageCodeEventQuery = async (code: BackendUsageCode, query: UsageCodeEventQueryDraft, page = 1) => {
    setUsageCodeEventModal((prev) => prev && prev.code.id === code.id ? { ...prev, loading: true, query } : {
      code,
      query,
      result: null,
      loading: true,
      expandedGroupKeys: [],
    })
    try {
      const result = await fetchBackendUsageCodeEvents(code.id, {
        page,
        pageSize: 50,
        timePreset: query.timePreset,
        startAt: query.timePreset === 'custom' ? toServerDateTimeValue(query.startAt) : undefined,
        endAt: query.timePreset === 'custom' ? toServerDateTimeValue(query.endAt) : undefined,
        bucket: query.bucket,
        eventCategories: query.eventCategories,
        taskId: query.taskId,
      })
      setUsageCodeEventModal({
        code,
        query,
        result,
        loading: false,
        expandedGroupKeys: [],
      })
    } catch (err) {
      setUsageCodeEventModal((prev) => prev ? { ...prev, loading: false } : prev)
      useStore.getState().showToast(
        `读取完整记录失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const openUsageCodeEventModal = (code: BackendUsageCode) => {
    const query = createDefaultUsageCodeEventQuery('today')
    setUsageCodeEventModal({
      code,
      query,
      result: null,
      loading: true,
      expandedGroupKeys: [],
    })
    void executeUsageCodeEventQuery(code, query, 1)
  }

  const updateUsageCodeEventQuery = (patch: Partial<UsageCodeEventQueryDraft>) => {
    setUsageCodeEventModal((prev) => prev ? {
      ...prev,
      query: {
        ...prev.query,
        ...patch,
      },
    } : prev)
  }

  const handleUsageCodeEventPresetChange = (value: BackendUsageCodeEventTimePreset) => {
    setUsageCodeEventModal((prev) => {
      if (!prev) return prev
      const nextDefaults = createDefaultUsageCodeEventQuery(value)
      return {
        ...prev,
        query: {
          ...prev.query,
          timePreset: value,
          startAt: nextDefaults.startAt,
          endAt: nextDefaults.endAt,
          bucket: getDefaultBucketForPreset(value),
        },
      }
    })
  }

  const runCurrentUsageCodeEventQuery = (page = 1) => {
    if (!usageCodeEventModal) return
    void executeUsageCodeEventQuery(usageCodeEventModal.code, usageCodeEventModal.query, page)
  }

  const resetUsageCodeEventQuery = () => {
    if (!usageCodeEventModal) return
    const nextQuery = createDefaultUsageCodeEventQuery('today')
    void executeUsageCodeEventQuery(usageCodeEventModal.code, nextQuery, 1)
  }

  const toggleUsageCodeEventGroup = (bucketKey: string) => {
    setUsageCodeEventModal((prev) => {
      if (!prev) return prev
      const expanded = prev.expandedGroupKeys.includes(bucketKey)
      return {
        ...prev,
        expandedGroupKeys: expanded
          ? prev.expandedGroupKeys.filter((item) => item !== bucketKey)
          : [...prev.expandedGroupKeys, bucketKey],
      }
    })
  }

  const getUsageCodeEventSummaryText = (summary: BackendUsageCodeEventSummary) => (
    [
      summary.generatedImageCount > 0 ? `图片 ${summary.generatedImageCount} 张` : '',
      summary.generatedVideoCount > 0 ? `视频 ${summary.generatedVideoCount} 个` : '',
      summary.imageQuotaIncreasedCredits > 0 ? `图片加额 ${summary.imageQuotaIncreasedCredits}` : '',
      summary.videoQuotaIncreasedCredits > 0 ? `视频加额 ${summary.videoQuotaIncreasedCredits}` : '',
      summary.imageQuotaDecreasedCredits > 0 ? `图片扣减 ${summary.imageQuotaDecreasedCredits}` : '',
      summary.videoQuotaDecreasedCredits > 0 ? `视频扣减 ${summary.videoQuotaDecreasedCredits}` : '',
      summary.deletedTaskCount > 0 ? `删除 ${summary.deletedTaskCount}` : '',
      summary.exportCount > 0 ? `导出 ${summary.exportCount}` : '',
      summary.apiAccessChangeCount > 0 ? `API 调整 ${summary.apiAccessChangeCount}` : '',
      summary.backupCount > 0 ? `备份 ${summary.backupCount}` : '',
      summary.createCount > 0 ? `创建 ${summary.createCount}` : '',
      summary.distributionChangeCount > 0 ? `分发 ${summary.distributionChangeCount}` : '',
      summary.renameCount > 0 ? `重命名 ${summary.renameCount}` : '',
      summary.enableDisableCount > 0 ? `启停 ${summary.enableDisableCount}` : '',
    ].filter(Boolean).join(' · ')
  )

  const buildUsageCodeEventSummaryCards = (
    summary: BackendUsageCodeEventSummary,
    eventCategories: BackendUsageCodeEventCategory[],
  ) => {
    const cards: Array<{ key: string; title: string; value: number }> = [
      { key: 'total', title: '总事件数', value: summary.totalEvents },
    ]
    const push = (key: string, title: string, value: number) => {
      if (value <= 0) return
      cards.push({ key, title, value })
    }
    const categorySet = new Set(eventCategories)
    const isAll = categorySet.has('all')
    if (isAll || categorySet.has('create')) push('create', '创建使用码', summary.createCount)
    if (isAll || categorySet.has('generate')) {
      push('generated-image', '生成图片', summary.generatedImageCount)
      push('generated-video', '生成视频', summary.generatedVideoCount)
    }
    if (isAll || categorySet.has('delete')) push('delete', '删除相关', summary.deletedTaskCount)
    if (isAll || categorySet.has('backup')) push('backup', '备份相关', summary.backupCount)
    if (isAll || categorySet.has('api_access_change')) push('api-access', 'API 调整', summary.apiAccessChangeCount)
    if (isAll || categorySet.has('quota_increase')) {
      push('image-quota-increase', '图片加额', summary.imageQuotaIncreasedCredits)
      push('video-quota-increase', '视频加额', summary.videoQuotaIncreasedCredits)
    }
    if (isAll || categorySet.has('quota_decrease')) {
      push('image-quota-decrease', '图片扣减', summary.imageQuotaDecreasedCredits)
      push('video-quota-decrease', '视频扣减', summary.videoQuotaDecreasedCredits)
    }
    if (isAll || categorySet.has('export')) push('export', '导出相关', summary.exportCount)
    if (isAll || categorySet.has('distribution_change')) push('distribution', '分发设置', summary.distributionChangeCount)
    if (isAll || categorySet.has('rename')) push('rename', '重命名', summary.renameCount)
    if (isAll || categorySet.has('enable_disable')) push('enable-disable', '启用与禁用', summary.enableDisableCount)
    return cards
  }

  const toggleUsageCodeEventCategory = (value: BackendUsageCodeEventCategory) => {
    setUsageCodeEventModal((prev) => {
      if (!prev) return prev
      const current = prev.query.eventCategories
      let next: BackendUsageCodeEventCategory[]
      if (value === 'all') {
        next = ['all']
      } else if (current.includes(value)) {
        next = current.filter((item) => item !== 'all' && item !== value)
        if (next.length === 0) next = ['all']
      } else {
        next = [...current.filter((item) => item !== 'all'), value]
      }
      return {
        ...prev,
        query: {
          ...prev.query,
          eventCategories: next,
        },
      }
    })
  }

  const getUsageCodeEventCategoryMenuLabel = (eventCategories: BackendUsageCodeEventCategory[]) => {
    if (eventCategories.includes('all')) return '全部事件'
    return categoryOptions
      .filter((item) => item.value !== 'all' && eventCategories.includes(item.value))
      .map((item) => item.label)
      .join('、')
  }

  const loadSettings = async () => {
    const [runtimeSettings, nextProfiles, nextProviderOptions, nextDistribution, nextUsageCodes, nextUsageCodeExportSummary, nextUsageCodeExportFiles, nextReminders, nextManagementLogs, nextMediaStats] = await Promise.all([
      fetchBackendRuntimeSettings().catch(() => null),
      isAdmin ? fetchBackendProviderProfiles().catch(() => []) : Promise.resolve([]),
      fetchBackendProviderOptions().catch(() => []),
      isAdmin ? fetchBackendDistribution().catch(() => ({ enabled: false, maxConcurrentTasks: 2 })) : Promise.resolve({ enabled: false, maxConcurrentTasks: 2 }),
      isAdmin ? fetchBackendUsageCodes().catch(() => []) : Promise.resolve([]),
      isAdmin ? Promise.resolve(null) : fetchUsageCodeMediaExportSummary().catch(() => null),
      isAdmin ? Promise.resolve([]) : fetchUsageCodeMediaExportFiles().then((result) => result.items).catch(() => []),
      isAdmin ? fetchAdminBackendReminders().catch(() => []) : fetchBackendReminders().catch(() => []),
      isAdmin ? fetchBackendManagementLogs().catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      isAdmin ? fetchBackendMediaStats().catch(() => null) : Promise.resolve(null),
    ])

    const nextDraft: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      ...(runtimeSettings
        ? {
            baseUrl: runtimeSettings.baseUrl,
            apiKey: runtimeSettings.apiKey,
            apiKeyMasked: runtimeSettings.apiKeyMasked ?? null,
            apiKeyConfigured: runtimeSettings.apiKeyConfigured,
            providerProfileId: settings.providerProfileId ?? runtimeSettings.id ?? null,
            model: runtimeSettings.model,
            apiMode: runtimeSettings.apiMode,
            timeout: runtimeSettings.timeoutSeconds,
            codexCli: runtimeSettings.codexCli,
            grokApiCompat: runtimeSettings.grokApiCompat,
            xaiImage2kEnabled: runtimeSettings.xaiImage2kEnabled,
          responseFormatB64Json: runtimeSettings.responseFormatB64Json,
          videoMaxResolution: runtimeSettings.videoMaxResolution ?? '480p',
          videoMaxDuration: runtimeSettings.videoMaxDuration ?? 6,
          clearInputAfterSubmit: runtimeSettings.clearInputAfterSubmit,
            persistInputOnRestart: runtimeSettings.persistInputOnRestart,
            reuseTaskApiProfileTemporarily: runtimeSettings.reuseTaskApiProfileTemporarily,
            alwaysShowRetryButton: runtimeSettings.alwaysShowRetryButton,
            showUsageCodeAliasOnTaskCard: runtimeSettings.showUsageCodeAliasOnTaskCard,
          }
        : {}),
    }

    setDraft(nextDraft)
    setSettings(nextDraft)
    setUsageCodeExportFiles(nextUsageCodeExportFiles)
    const visibleProfiles = nextProfiles.length || !runtimeSettings
      ? nextProfiles
      : [{
          id: runtimeSettings.id ?? 'default',
          name: runtimeSettings.name ?? '默认节点',
          baseUrl: runtimeSettings.baseUrl,
          apiKey: runtimeSettings.apiKey,
          apiKeyMasked: runtimeSettings.apiKeyMasked ?? null,
          apiKeyConfigured: runtimeSettings.apiKeyConfigured,
          model: runtimeSettings.model,
          apiMode: runtimeSettings.apiMode,
          timeoutSeconds: runtimeSettings.timeoutSeconds,
          codexCli: runtimeSettings.codexCli,
          grokApiCompat: runtimeSettings.grokApiCompat,
          xaiImage2kEnabled: runtimeSettings.xaiImage2kEnabled,
          responseFormatB64Json: runtimeSettings.responseFormatB64Json,
          videoMaxResolution: runtimeSettings.videoMaxResolution ?? '480p',
          videoMaxDuration: runtimeSettings.videoMaxDuration ?? 6,
          isDefault: true,
        }]

    setProfiles(visibleProfiles)
    setProviderOptions(nextProviderOptions)
    setDistribution(nextDistribution)
    const nextReminderDrafts = nextReminders.map(normalizeReminderForEditor)
    setReminderDrafts(nextReminderDrafts)
    setReminderImageUrlDrafts(createReminderImageUrlDraftMap(nextReminderDrafts))
    setExpandedReminderIds((prev) => {
      const previous = new Set(prev)
      return nextReminders
        .filter((item) => {
          const isNewDraft = !item.createdAt && !item.updatedAt
          return isNewDraft || previous.has(item.id)
        })
        .map((item) => item.id)
    })
    setUsageCodes(nextUsageCodes)
    setUsageCodeExportSummary(nextUsageCodeExportSummary)
    setManagementLogs(nextManagementLogs.items)
    setMediaStats(nextMediaStats)
    setExpandedUsageCodeIds((prev) => {
      const existing = new Set(prev)
      return nextUsageCodes
        .filter((code) => existing.has(code.id))
        .map((code) => code.id)
    })
    const selectedProfile = visibleProfiles.find((profile) => profile.id === nextDraft.providerProfileId)
      ?? visibleProfiles.find((profile) => profile.isDefault)
      ?? visibleProfiles[0]
    if (selectedProfile) {
      setProfileDraft(selectedProfile)
    } else {
      setProfileDraft(createEmptyProfile())
    }
  }

  useEffect(() => {
    if (!showSettings) return
    if (!isAdmin) setActiveTab('api')
    void loadSettings().catch((err) => {
      useStore.getState().showToast(
        `读取后端设置失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    })
  }, [showSettings, isAdmin])

  useEffect(() => {
    if (!showSettings || !isAdmin || activeTab !== 'data') return
    if (backupState?.phase !== 'completed' && backupState?.phase !== 'failed') return
    void fetchBackendManagementLogs()
      .then((result) => setManagementLogs(result.items))
      .catch(() => undefined)
  }, [showSettings, isAdmin, activeTab, backupState?.phase, backupState?.finishedAt])

  useEffect(() => {
    if (!showSettings || !isAdmin || activeTab !== 'data') return
    if (backupState?.phase !== 'completed' && backupState?.phase !== 'failed') return
    void fetchBackendMediaStats()
      .then((result) => setMediaStats(result))
      .catch(() => undefined)
  }, [showSettings, isAdmin, activeTab, backupState?.phase, backupState?.finishedAt])

  useEffect(() => {
    if (!showSettings || activeTab !== 'data') return
    if (backupState?.phase !== 'completed' || !backupState.finishedAt) return
    const remainingMs = COMPLETED_MAINTENANCE_CARD_MS - (Date.now() - new Date(backupState.finishedAt).getTime())
    if (remainingMs <= 0) return
    const timer = window.setTimeout(() => setMaintenanceCardNow(Date.now()), remainingMs + 50)
    return () => window.clearTimeout(timer)
  }, [showSettings, activeTab, backupState?.phase, backupState?.finishedAt])

  useEffect(() => {
    if (!showSettings || isAdmin) return
    if (backupState?.operation !== 'usage_code_media_export') return
    if (backupState.phase !== 'completed' && backupState.phase !== 'failed') return

    void fetchUsageCodeMediaExportSummary()
      .then((result) => setUsageCodeExportSummary(result))
      .catch(() => undefined)
    void fetchUsageCodeMediaExportFiles()
      .then((result) => setUsageCodeExportFiles(result.items))
      .catch(() => undefined)
  }, [showSettings, isAdmin, backupState?.operation, backupState?.phase, backupState?.finishedAt])

  useEffect(() => {
    if (!hasPendingUsageCodeDownload) return

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = '导出文件尚未处理完成。刷新后本次下载会中断。'
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasPendingUsageCodeDownload])

  useCloseOnEscape(showSettings, () => setShowSettings(false))
  useCloseOnEscape(Boolean(usageCodeEventModal), () => setUsageCodeEventModal(null))

  useEffect(() => {
    if (!usageCodeEventModal) {
      setIsUsageCodeEventCategoryMenuOpen(false)
    }
  }, [usageCodeEventModal])

  useEffect(() => {
    if (!isUsageCodeEventCategoryMenuOpen) return

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (usageCodeEventCategoryMenuRef.current?.contains(target)) return
      setIsUsageCodeEventCategoryMenuOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
    }
  }, [isUsageCodeEventCategoryMenuOpen])

  if (!showSettings) return null

  const updateDraft = (patch: Partial<AppSettings>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  const updateProfileDraft = (patch: Partial<BackendProviderProfile>) => {
    setProfileDraft((prev) => ({ ...prev, ...patch }))
  }

  const saveCurrentModelToDraft = () => {
    const normalizedModel = profileDraft.model.trim()
    if (!normalizedModel) return
    updateProfileDraft({
      model: normalizedModel,
      modelOptions: Array.from(new Set([...(profileDraft.modelOptions ?? []), normalizedModel])),
    })
  }

  const removeModelOptionFromDraft = (model: string) => {
    const nextOptions = (profileDraft.modelOptions ?? []).filter((item) => item !== model)
    updateProfileDraft({
      model: profileDraft.model === model
        ? (nextOptions[0] ?? '')
        : profileDraft.model,
      modelOptions: nextOptions,
    })
  }

  const refreshFromBackend = async () => {
    const [runtimeSettings, tasks] = await Promise.all([
      fetchBackendRuntimeSettings(),
      fetchBackendTasks(),
    ])

    if (runtimeSettings) {
      const nextSettings: Partial<AppSettings> = {
        baseUrl: runtimeSettings.baseUrl,
        apiKey: runtimeSettings.apiKey,
        apiKeyMasked: runtimeSettings.apiKeyMasked ?? null,
        apiKeyConfigured: runtimeSettings.apiKeyConfigured,
        model: runtimeSettings.model,
        apiMode: runtimeSettings.apiMode,
        timeout: runtimeSettings.timeoutSeconds,
        codexCli: runtimeSettings.codexCli,
        grokApiCompat: runtimeSettings.grokApiCompat,
        xaiImage2kEnabled: runtimeSettings.xaiImage2kEnabled,
        responseFormatB64Json: runtimeSettings.responseFormatB64Json,
        clearInputAfterSubmit: runtimeSettings.clearInputAfterSubmit,
        persistInputOnRestart: runtimeSettings.persistInputOnRestart,
        reuseTaskApiProfileTemporarily: runtimeSettings.reuseTaskApiProfileTemporarily,
        alwaysShowRetryButton: runtimeSettings.alwaysShowRetryButton,
        showUsageCodeAliasOnTaskCard: runtimeSettings.showUsageCodeAliasOnTaskCard,
      }
      setSettings(nextSettings)
      setDraft((prev) => ({ ...prev, ...nextSettings }))
    }

    useStore.getState().setTasks(tasks)
  }

  const handleSave = async () => {
    if (!isAdmin) {
      const selectedOption = providerOptions.find((option) => option.id === draft.providerProfileId)
        ?? providerOptions.find((option) => option.isDefault)
        ?? null
      setSettings(selectedOption
        ? {
            providerProfileId: selectedOption.id,
            apiMode: selectedOption.apiMode,
            model: selectedOption.model,
            timeout: selectedOption.timeoutSeconds,
            codexCli: selectedOption.codexCli,
            grokApiCompat: selectedOption.grokApiCompat,
            xaiImage2kEnabled: selectedOption.xaiImage2kEnabled,
            responseFormatB64Json: selectedOption.responseFormatB64Json,
          }
        : {
            providerProfileId: draft.providerProfileId ?? null,
          })
      setShowSettings(false)
      useStore.getState().showToast('API 选择已保存', 'success')
      return
    }

    const normalizedProfile: BackendProviderProfile = {
      ...profileDraft,
      name: profileDraft.name.trim() || '默认节点',
      remarkName: profileDraft.remarkName?.trim() || null,
      baseUrl: normalizeBaseUrl(profileDraft.baseUrl.trim() || DEFAULT_SETTINGS.baseUrl),
      model: profileDraft.model.trim() || getDefaultModelForMode(profileDraft.apiMode),
      modelOptions: Array.from(new Set(
        [profileDraft.model.trim() || getDefaultModelForMode(profileDraft.apiMode), ...(profileDraft.modelOptions ?? [])]
          .map((item) => String(item ?? '').trim())
          .filter(Boolean),
      )),
      timeoutSeconds: Number(profileDraft.timeoutSeconds) || DEFAULT_SETTINGS.timeout,
      apiMode: profileDraft.apiMode === 'videos' ? 'videos' : profileDraft.apiMode === 'responses' ? 'responses' : 'images',
      codexCli: profileDraft.apiMode === 'videos' ? false : profileDraft.codexCli,
      grokApiCompat: profileDraft.grokApiCompat,
      xaiImage2kEnabled: profileDraft.apiMode === 'images' && profileDraft.grokApiCompat ? profileDraft.xaiImage2kEnabled : false,
      responseFormatB64Json: profileDraft.apiMode === 'videos' ? false : profileDraft.responseFormatB64Json,
      videoMaxResolution: profileDraft.apiMode === 'videos' && profileDraft.grokApiCompat ? profileDraft.videoMaxResolution ?? '480p' : '480p',
      videoMaxDuration: profileDraft.apiMode === 'videos' && profileDraft.grokApiCompat ? profileDraft.videoMaxDuration ?? 6 : 6,
      isDefault: Boolean(profileDraft.isDefault),
    }

    if (!normalizedProfile.id && !normalizedProfile.apiKey?.trim()) {
      useStore.getState().showToast('新 API 配置需要填写 API Key', 'error')
      return
    }

    setIsSaving(true)
    try {
      const savedProfile = normalizedProfile.id
        ? await updateBackendProviderProfile(normalizedProfile)
        : await createBackendProviderProfile((() => {
            const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, apiKeyMasked: _apiKeyMasked, apiKeyConfigured: _apiKeyConfigured, ...payload } = normalizedProfile
            return payload
          })())
      const [nextProfiles, nextProviderOptions] = await Promise.all([
        fetchBackendProviderProfiles().catch(() => []),
        fetchBackendProviderOptions().catch(() => []),
      ])

      const savedPreferences = await saveBackendRuntimePreferences({
        clearInputAfterSubmit: draft.clearInputAfterSubmit,
        persistInputOnRestart: draft.persistInputOnRestart,
        reuseTaskApiProfileTemporarily: draft.reuseTaskApiProfileTemporarily,
        alwaysShowRetryButton: draft.alwaysShowRetryButton,
        showUsageCodeAliasOnTaskCard: draft.showUsageCodeAliasOnTaskCard,
      })

      const nextSettings: Partial<AppSettings> = {
        clearInputAfterSubmit: savedPreferences.clearInputAfterSubmit,
        persistInputOnRestart: savedPreferences.persistInputOnRestart,
        reuseTaskApiProfileTemporarily: savedPreferences.reuseTaskApiProfileTemporarily,
        alwaysShowRetryButton: savedPreferences.alwaysShowRetryButton,
        showUsageCodeAliasOnTaskCard: savedPreferences.showUsageCodeAliasOnTaskCard,
      }

      const refreshedSavedProfile = nextProfiles.find((profile) => profile.id === savedProfile.id) ?? savedProfile
      const activeProviderOption = settings.providerProfileId
        ? nextProviderOptions.find((option) => option.id === settings.providerProfileId) ?? null
        : null

      if (activeProviderOption) {
        Object.assign(nextSettings, {
          providerProfileId: activeProviderOption.id,
          model: activeProviderOption.model,
          apiMode: activeProviderOption.apiMode,
          timeout: activeProviderOption.timeoutSeconds,
          codexCli: activeProviderOption.codexCli,
          grokApiCompat: activeProviderOption.grokApiCompat,
          xaiImage2kEnabled: activeProviderOption.xaiImage2kEnabled,
          responseFormatB64Json: activeProviderOption.responseFormatB64Json,
          videoMaxResolution: activeProviderOption.videoMaxResolution ?? '480p',
          videoMaxDuration: activeProviderOption.videoMaxDuration ?? 6,
        } satisfies Partial<AppSettings>)
      }

      setSettings(nextSettings)
      setDraft((prev) => ({ ...prev, ...nextSettings }))
      setProfiles(nextProfiles)
      setProviderOptions(nextProviderOptions)
      setProfileDraft(refreshedSavedProfile)
      useStore.getState().showToast('设置已保存', 'success')
    } catch (err) {
      useStore.getState().showToast(
        `保存设置失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsSaving(false)
    }
  }

  const handleCopyProfile = () => {
    if (!profileDraft.id) {
      useStore.getState().showToast('请先选择一个已有 API 配置', 'info')
      return
    }
    setProfileDraft(createCopiedProfile(profileDraft))
    setShowApiKey(false)
    useStore.getState().showToast('已复制当前 API 配置', 'success')
  }

  const handleAddSessionUsageCode = async () => {
    const code = addCodeValue.trim()
    if (!code) return
    setIsSaving(true)
    try {
      const nextStatus = await addSessionUsageCode(code)
      setAuthStatus(nextStatus)
      setAddCodeValue('')
      const tasks = await fetchBackendTasks()
      setTasks(tasks)
      useStore.getState().showToast('使用码已添加', 'success')
    } catch (err) {
      useStore.getState().showToast(
        `添加使用码失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteProfile = () => {
    if (!profileDraft.id) {
      setProfileDraft(createEmptyProfile())
      return
    }

    setConfirmDialog({
      title: '删除 API 配置',
      message: `确定要删除「${profileDraft.name}」吗？已使用该配置提交的历史任务不会被删除。`,
      confirmText: '确认删除',
      tone: 'danger',
      action: () => {
        void deleteBackendProviderProfile(profileDraft.id)
          .then(() => loadSettings())
          .catch((err) => {
            useStore.getState().showToast(
              `删除 API 配置失败：${err instanceof Error ? err.message : String(err)}`,
              'error',
            )
          })
      },
    })
  }

  const startBackupExportNow = async () => {
    setIsExporting(true)
    try {
      await startBackendBackupExport()
      const nextStatus = await fetchAuthStatus()
      setAuthStatus(nextStatus)
      useStore.getState().showToast('服务器备份任务已启动', 'success')
    } catch (err) {
      useStore.getState().showToast(
        `启动备份失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsExporting(false)
    }
  }

  const handleExportBackup = () => {
    setConfirmDialog({
      title: '开始服务器备份',
      message: '确认后会先停止新的写入请求。系统会等待现有任务队列执行完成，再自动冻结普通用户和管理员的写入操作，然后开始生成服务器备份包。',
      confirmText: '确认开始',
      action: () => {
        void startBackupExportNow()
      },
    })
  }

  const handleExportUsageCodeMedia = async () => {
    setIsExporting(true)
    try {
      await startUsageCodeMediaExport()
      const latestAuth = await fetchAuthStatus()
      setAuthStatus(latestAuth)
      setUsageCodeExportFiles([])
      setUsageCodeDownloadStates({})
      useStore.getState().showToast('导出任务已开始。生成完成后可下载成品文件。', 'success')
    } catch (err) {
      useStore.getState().showToast(
        `导出图片与视频失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsExporting(false)
    }
  }

  const handleDownloadUsageCodeExportFile = async (fileName: string) => {
    const currentState = usageCodeDownloadStates[fileName]
    if (currentState?.status !== 'downloading' && activeUsageCodeDownloadCount >= 2) {
      useStore.getState().showToast('最多同时下载两个分包', 'info')
      return
    }

    const controller = new AbortController()
    usageCodeDownloadAbortControllersRef.current[fileName] = controller
    usageCodeDownloadStopActionsRef.current[fileName] = null
    setUsageCodeDownloadStates((prev) => ({
      ...prev,
      [fileName]: {
        status: 'downloading',
        loadedBytes: 0,
        totalBytes: null,
      },
    }))
    try {
      await downloadUsageCodeMediaExportFile(fileName, {
        signal: controller.signal,
        onProgress: ({ loadedBytes, totalBytes }) => {
          setUsageCodeDownloadStates((prev) => ({
            ...prev,
            [fileName]: {
              status: 'downloading',
              loadedBytes,
              totalBytes,
            },
          }))
        },
      })
      delete usageCodeDownloadAbortControllersRef.current[fileName]
      delete usageCodeDownloadStopActionsRef.current[fileName]
      setUsageCodeDownloadStates((prev) => ({
        ...prev,
        [fileName]: {
          status: 'success',
          loadedBytes: prev[fileName]?.totalBytes ?? prev[fileName]?.loadedBytes ?? 0,
          totalBytes: prev[fileName]?.totalBytes ?? prev[fileName]?.loadedBytes ?? null,
        },
      }))
      void markUsageCodeMediaExportDownloadCompleted(fileName).catch(() => undefined)
      useStore.getState().showToast('导出文件下载已开始保存', 'success')
    } catch (err) {
      const stopAction = usageCodeDownloadStopActionsRef.current[fileName]
      delete usageCodeDownloadAbortControllersRef.current[fileName]
      delete usageCodeDownloadStopActionsRef.current[fileName]
      if (isAbortError(err)) {
        if (stopAction === 'pause') {
          setUsageCodeDownloadStates((prev) => ({
            ...prev,
            [fileName]: {
              status: 'paused',
              loadedBytes: prev[fileName]?.loadedBytes ?? 0,
              totalBytes: prev[fileName]?.totalBytes ?? null,
            },
          }))
          useStore.getState().showToast('下载已暂停。继续后会重新开始。', 'info')
          return
        }
        setUsageCodeDownloadStates((prev) => ({
          ...prev,
          [fileName]: {
            status: 'idle',
            loadedBytes: 0,
            totalBytes: null,
          },
        }))
        useStore.getState().showToast('下载已取消', 'info')
        return
      }
      setUsageCodeDownloadStates((prev) => ({
        ...prev,
        [fileName]: {
          status: 'error',
          loadedBytes: prev[fileName]?.loadedBytes ?? 0,
          totalBytes: prev[fileName]?.totalBytes ?? null,
        },
      }))
      useStore.getState().showToast(
        `下载导出文件失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const handlePauseUsageCodeExportDownload = (fileName: string) => {
    const state = usageCodeDownloadStates[fileName]
    if (state?.status !== 'downloading') return
    usageCodeDownloadStopActionsRef.current[fileName] = 'pause'
    usageCodeDownloadAbortControllersRef.current[fileName]?.abort()
  }

  const handleCancelUsageCodeExportDownload = (fileName: string) => {
    const state = usageCodeDownloadStates[fileName]
    if (state?.status === 'downloading') {
      usageCodeDownloadStopActionsRef.current[fileName] = 'cancel'
      usageCodeDownloadAbortControllersRef.current[fileName]?.abort()
      return
    }
    setUsageCodeDownloadStates((prev) => ({
      ...prev,
      [fileName]: {
        status: 'idle',
        loadedBytes: 0,
        totalBytes: null,
      },
    }))
    useStore.getState().showToast('下载已取消', 'info')
  }

  const handleDeleteUsageCodeExportFiles = () => {
    setConfirmDialog({
      title: '删除远端备份',
      message: '确定要删除服务器上这次导出的备份文件吗？删除后需要重新导出才能再次下载。',
      confirmText: '确认删除',
      tone: 'danger',
      action: () => {
        setIsDeletingUsageCodeExportFiles(true)
        void deleteUsageCodeMediaExportFiles()
          .then(async () => {
            const latestAuth = await fetchAuthStatus()
            setAuthStatus(latestAuth)
            setUsageCodeExportFiles([])
            setUsageCodeDownloadStates({})
            useStore.getState().showToast('远端备份已删除', 'success')
          })
          .catch((err) => {
            useStore.getState().showToast(
              `删除远端备份失败：${err instanceof Error ? err.message : String(err)}`,
              'error',
            )
          })
          .finally(() => setIsDeletingUsageCodeExportFiles(false))
      },
    })
  }

  const handleSaveReminders = async () => {
    setIsSavingReminders(true)
    try {
      const saved = await saveBackendReminders(
        reminderDrafts.map((item) => ({
          ...item,
          startAt: toServerDateTimeValue(item.startAt),
          endAt: toServerDateTimeValue(item.endAt),
        })),
      )
      const nextReminderDrafts = saved.map(normalizeReminderForEditor)
      setReminderDrafts(nextReminderDrafts)
      setReminderImageUrlDrafts(createReminderImageUrlDraftMap(nextReminderDrafts))
      useStore.getState().showToast('提醒事项已保存', 'success')
    } catch (err) {
      useStore.getState().showToast(
        `保存提醒事项失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsSavingReminders(false)
    }
  }

  const handleReminderImageUrlChange = (reminderId: string, value: string) => {
    setReminderImageUrlDrafts((prev) => ({
      ...prev,
      [reminderId]: value,
    }))
    const imageDataUrls = normalizeReminderImageUrls(value.split(/\r?\n/))
    setReminderDrafts((prev) => prev.map((item) => {
      if (item.id !== reminderId) return item
      return {
        ...item,
        imageDataUrl: imageDataUrls[0] ?? null,
        imageDataUrls,
      }
    }))
  }

  const handleRemoveReminderImage = (reminderId: string, index: number) => {
    const nextDraftText = reminderDrafts
      .find((item) => item.id === reminderId)
      ?.imageDataUrls?.filter((_, currentIndex) => currentIndex !== index)
    setReminderImageUrlDrafts((prev) => ({
      ...prev,
      [reminderId]: formatReminderImageUrls(nextDraftText ?? []),
    }))
    setReminderDrafts((prev) => prev.map((item) => {
      if (item.id !== reminderId) return item
      const imageDataUrls = (item.imageDataUrls ?? []).filter((_, currentIndex) => currentIndex !== index)
      return {
        ...item,
        imageDataUrl: imageDataUrls[0] ?? null,
        imageDataUrls,
      }
    }))
  }

  const handleCreateReminder = () => {
    const nextReminder = createEmptyReminder()
    setReminderDrafts((prev) => [nextReminder, ...prev])
    setReminderImageUrlDrafts((prev) => ({
      ...prev,
      [nextReminder.id]: '',
    }))
    setExpandedReminderIds((prev) => prev.includes(nextReminder.id) ? prev : [nextReminder.id, ...prev])
  }

  const handleUpdateReminder = (reminderId: string, patch: Partial<BackendReminderItem>) => {
    setReminderDrafts((prev) => prev.map((item) => item.id === reminderId ? { ...item, ...patch } : item))
  }

  const handleDeleteReminder = (reminderId: string) => {
    setReminderDrafts((prev) => prev.filter((item) => item.id !== reminderId))
    setReminderImageUrlDrafts((prev) => {
      const next = { ...prev }
      delete next[reminderId]
      return next
    })
    setExpandedReminderIds((prev) => prev.filter((id) => id !== reminderId))
  }

  const toggleReminderExpanded = (reminderId: string) => {
    const reminder = reminderDrafts.find((item) => item.id === reminderId)
    const ended = reminder ? new Date(reminder.endAt).getTime() <= Date.now() : false
    setExpandedReminderIds((prev) => {
      const isExpanded = prev.includes(reminderId)
      if (isExpanded) {
        return prev.filter((id) => id !== reminderId)
      }
      if (ended && reminder) {
        markCompletedReminderSeen(reminder)
      }
      return [...prev, reminderId]
    })
  }

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length) return

    setIsImporting(true)
    try {
      const result = await importBackendBackup(files)
      await clearAllData({ silent: true })
      await refreshFromBackend()
      await loadSettings()
      setShowImportCandidates(false)
      useStore.getState().showToast(
        `导入完成：${result.importedTasks} 条任务，${result.importedImages} 个媒体文件`,
        'success',
      )
    } catch (err) {
      useStore.getState().showToast(
        `导入备份失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsImporting(false)
    }
  }

  const handleLoadImportCandidates = async () => {
    setIsImporting(true)
    try {
      const result = await fetchAdminBackupImportCandidates()
      setImportCandidates(result.items)
      setShowImportCandidates(true)
      if (!result.items.length) {
        useStore.getState().showToast('未发现服务器备份包，可以上传本地备份', 'info')
      }
    } catch (err) {
      useStore.getState().showToast(
        `读取备份列表失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsImporting(false)
    }
  }

  const handleImportServerBackup = async (archivePath: string) => {
    setIsImporting(true)
    try {
      const result = await importBackendBackupFromServer(archivePath)
      await clearAllData({ silent: true })
      await refreshFromBackend()
      await loadSettings()
      setShowImportCandidates(false)
      useStore.getState().showToast(
        `恢复完成：${result.importedTasks} 条任务，${result.importedImages} 个媒体文件`,
        'success',
      )
    } catch (err) {
      useStore.getState().showToast(
        `恢复备份失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsImporting(false)
    }
  }

  const handleResetRemoteData = async (mode: 'tasks' | 'all' | 'usage_code_tasks_only') => {
    setIsClearingRemote(true)
    try {
      await resetBackendRemoteData(mode)
      const latestAuth = await fetchAuthStatus()
      useStore.getState().setAuthStatus(latestAuth)
      useStore.getState().showToast('清理任务已提交，请等待进度完成', 'success')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      useStore.getState().showToast(
        message.includes('当前已有维护任务正在执行')
          ? '当前已有清理或备份任务正在执行，请等待完成后再试'
          : `清空远端存储失败：${message}`,
        message.includes('当前已有维护任务正在执行') ? 'info' : 'error',
      )
    } finally {
      setIsClearingRemote(false)
    }
  }

  const handleToggleDistribution = async (enabled: boolean) => {
    try {
      const saved = await saveBackendDistribution({ ...distribution, enabled })
      setDistribution(saved)
      useStore.getState().showToast(enabled ? '分发功能已开启' : '分发功能已关闭', 'success')
    } catch (err) {
      useStore.getState().showToast(
        `保存分发设置失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const handleSaveConcurrency = async () => {
    try {
      const saved = await saveBackendDistribution(distribution)
      setDistribution(saved)
      useStore.getState().showToast('并发设置已保存', 'success')
    } catch (err) {
      useStore.getState().showToast(
        `保存并发设置失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const handleCreateUsageCode = async () => {
    const createQuotaMap = (
      quotaProfiles: BackendProviderProfile[],
      draftValues: Record<string, string>,
    ) => {
      const entries: Array<readonly [string, number]> = []
      for (const profile of quotaProfiles) {
        const rawValue = draftValues[profile.id] ?? '0'
        const quota = calculateQuotaExpression(rawValue, 0)
        if (quota == null || !Number.isInteger(quota) || quota < 0) return undefined
        entries.push([profile.id, quota] as const)
      }
      return Object.fromEntries(entries)
    }
    const providerImageQuotas = createQuotaMap(
      getQuotaEditorProfiles(newCodeAllowedProviderProfileIds, 'image'),
      newCodeProviderImageQuotas,
    )
    const providerVideoQuotas = createQuotaMap(
      getQuotaEditorProfiles(newCodeAllowedProviderProfileIds, 'video'),
      newCodeProviderVideoQuotas,
    )
    if (!providerImageQuotas) {
      useStore.getState().showToast('API 图片额度需要是非负整数', 'error')
      return
    }
    if (!providerVideoQuotas) {
      useStore.getState().showToast('API 视频额度需要是非负整数', 'error')
      return
    }

    try {
      const result = await createBackendUsageCode({
        name: newCodeName.trim() || '未命名使用码',
        userTier: newCodeUserTier,
        allowedProviderProfileIds: newCodeAllowedProviderProfileIds,
        providerImageQuotas,
        providerVideoQuotas,
      })
      setLatestPlainCode(result.code)
      setUsageCodes((prev) => [result.item, ...prev.filter((item) => item.id !== result.item.id)])
      setNewCodeName('')
      setNewCodeUserTier('free')
      setNewCodeAllowedProviderProfileIds([])
      setNewCodeProviderImageQuotas({})
      setNewCodeProviderVideoQuotas({})
      useStore.getState().showToast('使用码已生成，明文只显示一次', 'success')
    } catch (err) {
      useStore.getState().showToast(
        `生成使用码失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const handleUpdateUsageCode = async (
    codeId: string,
    patch: {
      name?: string
      userTier?: BackendUsageCodeUserTier
      isEnabled?: boolean
      allowedProviderProfileIds?: string[] | null
      providerImageQuotas?: Record<string, number> | null
      providerVideoQuotas?: Record<string, number> | null
    },
  ) => {
    try {
      const updated = await updateBackendUsageCode(codeId, patch)
      setUsageCodes((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    } catch (err) {
      useStore.getState().showToast(
        `更新使用码失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const handleSubmitProviderQuota = async (
    code: BackendUsageCode,
    providerProfileId: string,
    quotaType: 'image' | 'video',
  ) => {
    const draftState = quotaType === 'video' ? usageCodeProviderVideoQuotaDrafts : usageCodeProviderImageQuotaDrafts
    const setDraftState = quotaType === 'video' ? setUsageCodeProviderVideoQuotaDrafts : setUsageCodeProviderImageQuotaDrafts
    const draftValue = draftState[code.id]?.[providerProfileId]
    if (draftValue === undefined) return

    const trimmedValue = draftValue.trim()
    const currentQuota = quotaType === 'video'
      ? code.providerVideoQuotas?.[providerProfileId] ?? 0
      : code.providerImageQuotas?.[providerProfileId] ?? 0
    const currentDisplayValue = String(currentQuota)
    if ((trimmedValue || '0') === currentDisplayValue) return

    const nextQuota = calculateQuotaExpression(trimmedValue || '0', currentQuota)
    if (nextQuota == null) {
      useStore.getState().showToast(`端点${quotaType === 'video' ? '视频' : '图片'}额度表达式无效`, 'error')
      setDraftState((prev) => ({
        ...prev,
        [code.id]: {
          ...(prev[code.id] ?? {}),
          [providerProfileId]: currentDisplayValue,
        },
      }))
      return
    }

    const nextProviderQuotas = {
      ...(quotaType === 'video' ? code.providerVideoQuotas ?? {} : code.providerImageQuotas ?? {}),
      [providerProfileId]: nextQuota,
    }
    await handleUpdateUsageCode(
      code.id,
      quotaType === 'video'
        ? { providerVideoQuotas: nextProviderQuotas }
        : { providerImageQuotas: nextProviderQuotas },
    )
    setDraftState((prev) => ({
      ...prev,
      [code.id]: {
        ...(prev[code.id] ?? {}),
        [providerProfileId]: String(nextQuota),
      },
    }))
  }

  const handleDeleteUsageCode = (code: BackendUsageCode) => {
    setConfirmDialog({
      title: '删除使用码',
      message: `确定要删除「${code.name}」吗？该使用码会立即失效，历史任务仍保留给管理员查看。`,
      confirmText: '确认删除',
      tone: 'danger',
      action: () => {
        void deleteBackendUsageCode(code.id)
          .then(() => {
            setUsageCodes((prev) => prev.filter((item) => item.id !== code.id))
            useStore.getState().showToast('使用码已删除', 'success')
          })
          .catch((err) => {
            useStore.getState().showToast(
              `删除使用码失败：${err instanceof Error ? err.message : String(err)}`,
              'error',
            )
          })
      },
    })
  }

  const toggleUsageCodeExpanded = (codeId: string) => {
    setExpandedUsageCodeIds((prev) =>
      prev.includes(codeId)
        ? prev.filter((id) => id !== codeId)
        : [...prev, codeId],
    )
  }

  const tabClass = (tab: SettingsTab) =>
    `flex shrink-0 items-center gap-1.5 rounded-2xl px-4 py-2 text-sm font-medium transition ${
      activeTab === tab
        ? 'bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-300'
        : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.06]'
    }`

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="glass-overlay-soft absolute inset-0 animate-overlay-in"
        onClick={() => setShowSettings(false)}
      />
      <div ref={settingsPanelRef} className="glass-surface-strong relative z-10 flex h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-white/50 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:ring-white/10">
        <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">设置</h3>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              className="rounded-lg bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500 transition hover:bg-gray-200 hover:text-gray-700 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
            >
              操作指南
            </button>
            <span className="text-xs font-mono text-gray-400 dark:text-gray-500 select-none">v{__APP_VERSION__}</span>
            <button
              onClick={() => setShowSettings(false)}
              className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="tiny-scrollbar flex gap-2 overflow-x-auto border-b border-gray-100 px-5 py-3 dark:border-white/[0.08]">
          {isAdmin && <button className={tabClass('habits')} onClick={() => setActiveTab('habits')}>习惯配置</button>}
          <button className={tabClass('api')} onClick={() => setActiveTab('api')}>API 配置</button>
          {isAdmin && (
            <button className={tabClass('distribution')} onClick={() => setActiveTab('distribution')}>
              分发管理
              {hasUnreadEndedReminders && (
                <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
              )}
            </button>
          )}
          {isAdmin && <button className={tabClass('data')} onClick={() => setActiveTab('data')}>数据管理</button>}
        </div>

        <div className="tiny-scrollbar flex-1 overflow-y-auto px-5 py-4">
          {activeTab === 'habits' && (
            <div className="divide-y divide-gray-100 dark:divide-white/[0.08]">
              <PreferenceRow
                title="提交任务后清空输入框"
                description="开启后，任务创建成功时会清空提示词、参考图和遮罩。"
                checked={draft.clearInputAfterSubmit}
                onChange={(checked) => updateDraft({ clearInputAfterSubmit: checked })}
              />
              <PreferenceRow
                title="重启后加载上次的输入框"
                description="关闭后，不再持久化提示词和参考图，下次启动会使用空输入框。"
                checked={draft.persistInputOnRestart}
                onChange={(checked) => updateDraft({ persistInputOnRestart: checked })}
              />
              <PreferenceRow
                title="复用配置时临时复用该任务的 API 配置"
                description="当前后端版本会保存该习惯配置。任务级 API 复用会在后续请求链路继续接入。"
                checked={draft.reuseTaskApiProfileTemporarily}
                onChange={(checked) => updateDraft({ reuseTaskApiProfileTemporarily: checked })}
              />
              <PreferenceRow
                title="成功任务仍然展示重试按钮"
                description="当前后端版本会保存该习惯配置。重试入口会在任务卡片清理时接入。"
                checked={draft.alwaysShowRetryButton}
                onChange={(checked) => updateDraft({ alwaysShowRetryButton: checked })}
              />
              <PreferenceRow
                title="任务卡片中的使用码显示别名"
                description="只影响管理员查看任务卡片和详情时的使用码按钮文本。普通用户仍显示使用码本身。"
                checked={draft.showUsageCodeAliasOnTaskCard}
                onChange={(checked) => updateDraft({ showUsageCodeAliasOnTaskCard: checked })}
              />
            </div>
          )}

          {activeTab === 'api' && !isAdmin && (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">可用 API</span>
                <Select
                  value={draft.providerProfileId ?? providerOptions.find((option) => option.isDefault)?.id ?? ''}
                  onChange={(value) => updateDraft({ providerProfileId: String(value) })}
                  options={providerOptions.map((option) => ({
                    label: renderProviderOptionLabel(option, { showUserRemaining: true }),
                    value: option.id,
                  }))}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>
              <div className="space-y-3 rounded-xl border border-gray-200/70 bg-gray-50/60 px-3 py-3 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300">
                <div className="font-medium text-gray-800 dark:text-gray-100">当前使用码</div>
                <div className="space-y-2">
                  {userUsageCodes.map((code) => (
                    <div key={code.id} className="rounded-lg bg-white/70 px-3 py-2 dark:bg-white/[0.04]">
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate font-medium">{code.name}</span>
                        <div className="shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">
                          <div>图片剩余 {code.remainingImageCredits ?? 0}</div>
                          <div>视频剩余 {code.remainingVideoCredits ?? 0}</div>
                        </div>
                      </div>
                      {providerOptions.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {providerOptions
                            .filter((option) => !code.allowedProviderProfileIds?.length || code.allowedProviderProfileIds.includes(option.id))
                            .map((option) => {
                              const isVideoProvider = option.apiMode === 'videos'
                              const providerRemaining = isVideoProvider
                                ? code.providerRemainingVideoCredits?.[option.id]
                                : code.providerRemainingImageCredits?.[option.id]
                              return (
                                <div key={option.id} className="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
                                  <span className="min-w-0 truncate">{option.name}</span>
                                  <span className="shrink-0">
                                    {isVideoProvider ? '视频剩余' : '图片剩余'} {providerRemaining ?? 0}
                                  </span>
                                </div>
                              )
                            })}
                        </div>
                      )}
                    </div>
                  ))}
                  {!userUsageCodes.length && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">当前没有可用使用码。</div>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    value={addCodeValue}
                    onChange={(event) => setAddCodeValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void handleAddSessionUsageCode()
                      }
                    }}
                    placeholder="输入新的使用码"
                    className="min-w-0 flex-1 rounded-lg border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.04]"
                  />
                  <button
                    type="button"
                    onClick={() => void handleAddSessionUsageCode()}
                    disabled={isSaving || !addCodeValue.trim()}
                    className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    添加
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => void handleExportUsageCodeMedia()}
                  disabled={isSaving || isExporting || isUsageCodeExportActive}
                  className="w-full rounded-lg border border-gray-200/70 bg-white/80 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08]"
                >
                  {isExporting ? '提交中...' : isUsageCodeExportActive ? '导出进行中...' : '导出图片与视频'}
                </button>
                <div className="rounded-lg border border-dashed border-gray-200/70 bg-white/40 px-3 py-2 text-xs text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-400">
                  {usageCodeExportSummary
                    ? `本次将导出 ${usageCodeExportSummary.imageCount} 张图片、${usageCodeExportSummary.videoCount} 个视频，预计总大小 ${formatBytes(usageCodeExportSummary.totalBytes)}。`
                    : '正在读取导出预估信息。'}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  压缩包只包含当前使用码对应的图片文件和视频文件。超过 512 MB 会自动分包。
                </div>
                {usageCodeExportFiles.length > 1 && backupState?.phase === 'completed' && (
                  <div className="text-xs text-blue-600 dark:text-blue-300">
                    本次导出共 {usageCodeExportFiles.length} 个分包。请全部下载后再统一保存。
                  </div>
                )}
                {shouldShowUsageCodeExportStatus && backupState && (
                  <div className="rounded-lg border border-blue-200/70 bg-blue-50/70 px-3 py-3 dark:border-blue-400/20 dark:bg-blue-500/10">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-blue-900 dark:text-blue-100">
                        {backupState.phase === 'completed'
                          ? '导出已完成'
                          : backupState.phase === 'failed'
                            ? '导出失败'
                            : '正在生成导出文件'}
                      </div>
                      <div className="text-sm font-semibold text-blue-800 dark:text-blue-100">{backupState.progressPercent}%</div>
                    </div>
                    <div className="mt-2 text-xs leading-5 text-blue-700/90 dark:text-blue-200/80">
                      {backupState.error || backupState.message}
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-200/70 dark:bg-white/10">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
                        style={{ width: `${Math.max(4, backupState.progressPercent)}%` }}
                      />
                    </div>
                    <div className="mt-2 text-xs leading-5 text-blue-700/90 dark:text-blue-200/80">
                      {backupState.phase === 'preparing'
                        ? '正在整理导出文件。'
                        : backupState.phase === 'completed' && usageCodeExportFiles.length > 1
                          ? `已生成 ${usageCodeExportFiles.length} 个分包，合计 ${formatBytes(backupState.totalBytes)}`
                          : `已处理 ${backupState.processedFiles}/${backupState.totalFiles} 个文件，${formatBytes(backupState.processedBytes)}/${formatBytes(backupState.totalBytes)}`}
                    </div>
                    {usageCodeExportFiles.length > 0 && backupState.phase === 'completed' && (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-200/60 bg-white/70 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
                          <div className="text-[11px] text-blue-700/90 dark:text-blue-200/80">
                            远端备份保存在服务器。最多同时下载两个分包。删除后，当前这批下载文件会一并失效。
                          </div>
                          <button
                            type="button"
                            onClick={handleDeleteUsageCodeExportFiles}
                            disabled={isDeletingUsageCodeExportFiles || hasPendingUsageCodeDownload}
                            className="shrink-0 rounded-md border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-400/20 dark:bg-white/[0.04] dark:text-red-200 dark:hover:bg-white/[0.08]"
                          >
                            {isDeletingUsageCodeExportFiles ? '删除中...' : '删除远端备份'}
                          </button>
                        </div>
                        {usageCodeExportFiles.map((item) => {
                          const downloadState = usageCodeDownloadStates[item.fileName] ?? {
                            status: 'idle',
                            loadedBytes: 0,
                            totalBytes: null,
                          }
                          const isDownloading = downloadState.status === 'downloading'
                          const isPaused = downloadState.status === 'paused'
                          const isSuccess = downloadState.status === 'success'
                          const progressPercent = downloadState.totalBytes && downloadState.totalBytes > 0
                            ? Math.min(100, Math.floor((downloadState.loadedBytes / downloadState.totalBytes) * 100))
                            : 12

                          return (
                            <div
                              key={item.fileName}
                              className="rounded-lg border border-blue-200/60 bg-white/70 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-xs font-medium text-blue-900 dark:text-blue-100">{item.fileName}</div>
                                  <div className="text-[11px] text-blue-700/90 dark:text-blue-200/80">
                                    {downloadState.totalBytes
                                      ? `${formatBytes(downloadState.loadedBytes)} / ${formatBytes(downloadState.totalBytes)}`
                                      : formatBytes(item.bytes)}
                                  </div>
                                </div>
                                <div className="flex shrink-0 gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void handleDownloadUsageCodeExportFile(item.fileName)}
                                    disabled={isDownloading || (downloadState.status !== 'downloading' && activeUsageCodeDownloadCount >= 2)}
                                    className="rounded-md border border-blue-200 bg-white px-3 py-1 text-xs font-medium text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-400/20 dark:bg-white/[0.04] dark:text-blue-100 dark:hover:bg-white/[0.08]"
                                  >
                                    {isSuccess
                                      ? '下载成功'
                                      : isPaused
                                        ? '继续下载'
                                        : isDownloading
                                          ? '下载中...'
                                          : downloadState.status === 'error'
                                            ? '重新下载'
                                            : '下载'}
                                  </button>
                                  {(isDownloading || isPaused) && (
                                    <>
                                      {isDownloading && (
                                        <button
                                          type="button"
                                          onClick={() => handlePauseUsageCodeExportDownload(item.fileName)}
                                          className="rounded-md border border-blue-200 bg-white px-3 py-1 text-xs font-medium text-blue-700 transition hover:bg-blue-50 dark:border-blue-400/20 dark:bg-white/[0.04] dark:text-blue-100 dark:hover:bg-white/[0.08]"
                                        >
                                          暂停
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => handleCancelUsageCodeExportDownload(item.fileName)}
                                        className="rounded-md border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-400/20 dark:bg-white/[0.04] dark:text-red-200 dark:hover:bg-white/[0.08]"
                                      >
                                        取消
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                              {(isDownloading || isPaused) && (
                                <>
                                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-200/70 dark:bg-white/10">
                                    <div
                                      className="h-full rounded-full bg-blue-500 transition-[width] duration-200"
                                      style={{ width: `${Math.max(4, progressPercent)}%` }}
                                    />
                                  </div>
                                  <div className="mt-2 text-[11px] text-blue-700/90 dark:text-blue-200/80">
                                    {isPaused
                                      ? '下载已暂停。继续后会重新开始。'
                                      : downloadState.totalBytes && downloadState.totalBytes > 0
                                        ? `下载进度 ${progressPercent}%`
                                        : `已下载 ${formatBytes(downloadState.loadedBytes)}`}
                                  </div>
                                </>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setConfirmDialog({
                      title: '清除浏览器缓存',
                      message: '这会清空当前浏览器中的任务记录、图片缓存、视频缓存和输入草稿。\n\n不会删除服务器上的任务、图片、视频和使用码额度。',
                      confirmText: '确认清除',
                      tone: 'warning',
                      action: () => {
                        void clearAllData()
                      },
                    })
                  }
                  className="w-full rounded-lg border border-orange-200/80 bg-orange-50/50 px-4 py-2 text-sm font-medium text-orange-600 transition hover:bg-orange-100/80 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-300 dark:hover:bg-orange-500/20"
                >
                  清除浏览器缓存
                </button>
              </div>
            </div>
          )}

          {activeTab === 'api' && isAdmin && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_5rem]">
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <Select
                    value={selectedProfileId}
                    onChange={(value) => {
                      if (value === '__new__') {
                        setProfileDraft(createEmptyProfile())
                        return
                      }
                      const profile = profiles.find((item) => item.id === value)
                      if (profile) setProfileDraft(profile)
                    }}
                    options={[
                      ...profiles.map((profile) => ({
                        label: renderProviderOptionLabel(profile, { showDistributedRemaining: true }),
                        value: profile.id,
                      })),
                      { label: '新增 API 配置', value: '__new__' },
                    ]}
                    className="rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleCopyProfile}
                  disabled={!profileDraft.id}
                  className="min-w-0 whitespace-nowrap rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm font-medium leading-normal text-gray-600 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.08]"
                >
                  复制
                </button>
                <button
                  type="button"
                  onClick={() => setProfileDraft(createEmptyProfile())}
                  className="min-w-0 whitespace-nowrap rounded-xl bg-blue-50 px-3 py-2 text-sm font-medium leading-normal text-blue-500 transition hover:bg-blue-100 dark:bg-blue-500/10 dark:hover:bg-blue-500/20"
                >
                  新增
                </button>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">配置名称</span>
                <ClearableInput
                  value={profileDraft.name}
                  onChange={(event) => updateProfileDraft({ name: event.target.value })}
                  onClear={() => updateProfileDraft({ name: '' })}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">API 备注名</span>
                <ClearableInput
                  value={profileDraft.remarkName ?? ''}
                  onChange={(event) => updateProfileDraft({ remarkName: event.target.value })}
                  onClear={() => updateProfileDraft({ remarkName: '' })}
                  placeholder="只给管理员显示"
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">API URL</span>
                <ClearableInput
                  value={profileDraft.baseUrl}
                  onChange={(event) => updateProfileDraft({ baseUrl: event.target.value })}
                  onClear={() => updateProfileDraft({ baseUrl: '' })}
                  placeholder={DEFAULT_SETTINGS.baseUrl}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>

              <div>
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">API Key</span>
                <div className="relative">
                  <ClearableInput
                    value={profileDraft.apiKey ?? ''}
                    onChange={(event) => updateProfileDraft({ apiKey: event.target.value })}
                    onClear={() => updateProfileDraft({ apiKey: '' })}
                    type={showApiKey ? 'text' : 'password'}
                    placeholder={profileDraft.apiKeyMasked ?? '输入后保存到后端'}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 pr-20 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((value) => !value)}
                    className="absolute inset-y-0 right-8 flex items-center px-3 text-gray-400 transition hover:text-gray-600 dark:hover:text-gray-200"
                    aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {showApiKey ? (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18M10.584 10.587a2 2 0 102.829 2.829M9.88 4.24A9.956 9.956 0 0112 4c5.523 0 10 4 10 8 0 1.354-.512 2.629-1.414 3.742M6.228 6.228C3.608 7.8 2 9.777 2 12c0 4 4.477 8 10 8 2.09 0 4.03-.572 5.648-1.55" />
                      ) : (
                        <>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.269 2.943 9.542 7-1.273 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </>
                      )}
                    </svg>
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">API 接口</span>
                <Select
                  value={profileDraft.apiMode}
                  onChange={(value) => {
                    const apiMode = value as AppSettings['apiMode']
                    const model =
                      profileDraft.model === DEFAULT_IMAGES_MODEL
                      || profileDraft.model === DEFAULT_RESPONSES_MODEL
                      || profileDraft.model === 'grok-imagine-video'
                        ? getDefaultModelForMode(apiMode)
                        : profileDraft.model
                    updateProfileDraft({ apiMode, model })
                  }}
                  options={[
                    { label: 'Images API (/v1/images)', value: 'images' },
                    { label: 'Responses API (/v1/responses)', value: 'responses' },
                    { label: 'Videos API (/v1/videos)', value: 'videos' },
                  ]}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">模型 ID</span>
                <ClearableInput
                  value={profileDraft.model}
                  onChange={(event) => updateProfileDraft({ model: event.target.value })}
                  onBlur={saveCurrentModelToDraft}
                  onClear={() => updateProfileDraft({ model: '' })}
                  placeholder={getDefaultModelForMode(profileDraft.apiMode)}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>

              <div className="rounded-2xl border border-gray-200/70 bg-gray-50/60 px-3 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">已保存模型</span>
                  <button
                    type="button"
                    onClick={saveCurrentModelToDraft}
                    className="rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-600 transition hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20"
                  >
                    保存当前模型
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(profileDraft.modelOptions ?? []).length > 0 ? (
                    (profileDraft.modelOptions ?? []).map((model) => {
                      const selected = model === profileDraft.model
                      return (
                        <div
                          key={model}
                          className={`inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-xs ${
                            selected
                              ? 'bg-blue-500 text-white'
                              : 'bg-white text-gray-600 ring-1 ring-gray-200 dark:bg-white/[0.05] dark:text-gray-300 dark:ring-white/[0.08]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => updateProfileDraft({ model })}
                            className="truncate text-left"
                            title={model}
                          >
                            {model}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeModelOptionFromDraft(model)}
                            className={selected ? 'text-white/80 hover:text-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'}
                            aria-label={`删除模型 ${model}`}
                          >
                            ×
                          </button>
                        </div>
                      )
                    })
                  ) : (
                    <span className="text-xs text-gray-400 dark:text-gray-500">当前没有已保存模型</span>
                  )}
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">请求超时 (秒)</span>
                <ClearableInput
                  value={profileDraft.timeoutSeconds}
                  onChange={(event) => updateProfileDraft({ timeoutSeconds: Number(event.target.value) })}
                  onClear={() => updateProfileDraft({ timeoutSeconds: 0 })}
                  type="number"
                  min={10}
                  max={1800}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>

              <div className="divide-y divide-gray-100 rounded-2xl border border-gray-200/70 bg-gray-50/60 px-3 dark:divide-white/[0.08] dark:border-white/[0.08] dark:bg-white/[0.03]">
                <PreferenceRow
                  title="Grok API 兼容"
                  description={profileDraft.apiMode === 'videos'
                    ? '启用后该视频配置会显示 Grok 相关能力设置。'
                    : '启用后改用 xAI Images 接口的字段。尺寸会换算成 xAI 支持的比例与分辨率。遮罩编辑不会提交到该接口。'}
                  checked={profileDraft.grokApiCompat}
                  onChange={(checked) => updateProfileDraft({
                    grokApiCompat: checked,
                    ...(checked ? { codexCli: false } : { xaiImage2kEnabled: false }),
                  })}
                />
                {profileDraft.apiMode === 'videos' && profileDraft.grokApiCompat && (
                  <div className="space-y-4 py-3">
                    <VideoCapabilitySlider
                      title="视频分辨率"
                      value={profileDraft.videoMaxResolution ?? '480p'}
                      labels={['480p', '720p']}
                      onChange={(value) => updateProfileDraft({ videoMaxResolution: value as '480p' | '720p' })}
                    />
                    <VideoCapabilitySlider
                      title="视频时长"
                      value={String(profileDraft.videoMaxDuration ?? 6)}
                      labels={['6', '10', '15']}
                      suffix="s"
                      onChange={(value) => updateProfileDraft({ videoMaxDuration: Number(value) as 6 | 10 | 15 })}
                    />
                  </div>
                )}
                {profileDraft.apiMode !== 'videos' && (
                  <>
                    {profileDraft.grokApiCompat && (
                      <PreferenceRow
                        title="允许 xAI 2K 图片"
                        description="开启后，xAI 图片接口会按请求尺寸尽量使用 2K。关闭时，xAI 图片仍固定使用 1K。"
                        checked={profileDraft.xaiImage2kEnabled}
                        onChange={(checked) => updateProfileDraft({ xaiImage2kEnabled: checked })}
                      />
                    )}
                    <PreferenceRow
                      title="Codex CLI 模式"
                      description="禁用该接口不支持的质量参数，并使用兼容的多图提交方式。"
                      checked={profileDraft.codexCli}
                      onChange={(checked) => updateProfileDraft({
                        codexCli: checked,
                        ...(checked ? { grokApiCompat: false, xaiImage2kEnabled: false } : {}),
                      })}
                    />
                    <PreferenceRow
                      title="返回 Base64 图片数据"
                      description={<>开启后在请求体中加入 <code className="rounded bg-gray-200 px-1 py-0.5 font-mono dark:bg-white/[0.08]">response_format: b64_json</code>，尝试让接口直接返回 Base64 图片。</>}
                      checked={profileDraft.responseFormatB64Json}
                      onChange={(checked) => updateProfileDraft({ responseFormatB64Json: checked })}
                    />
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleDeleteProfile}
                  className="rounded-xl border border-red-200/70 bg-red-50/50 px-4 py-2.5 text-sm font-medium text-red-500 transition hover:bg-red-100/80 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400"
                >
                  删除配置
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSaving ? '保存中...' : '保存'}
                </button>
              </div>
            </div>
          )}

          {activeTab === 'distribution' && isAdmin && (
            <div className="space-y-4">
              <PreferenceRow
                title="开启分发功能"
                description="开启后，普通用户可以用使用码登录。关闭后，只有管理员可以使用。"
                checked={distribution.enabled}
                onChange={handleToggleDistribution}
              />

              <div className="rounded-2xl border border-gray-200/70 bg-gray-50/60 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-100">同时执行任务数</span>
                  <span className="mb-2 block text-xs text-gray-500 dark:text-gray-400">超过该数量的任务会进入队列，按提交顺序执行。</span>
                  <ClearableInput
                    value={distribution.maxConcurrentTasks}
                    onChange={(event) => setDistribution((prev) => ({
                      ...prev,
                      maxConcurrentTasks: Math.max(1, Number(event.target.value) || 1),
                    }))}
                    onClear={() => setDistribution((prev) => ({ ...prev, maxConcurrentTasks: 1 }))}
                    onBlur={handleSaveConcurrency}
                    type="number"
                    min={1}
                    max={50}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                  />
                </label>
              </div>

              <div className="space-y-4 rounded-2xl border border-gray-200/70 bg-gray-50/60 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-100">公共提醒事项</div>
                    <div className="mt-1 text-xs leading-6 text-gray-500 dark:text-gray-400">
                      事项会在生效时间内按设定频率向使用码用户弹出。结束后仍保留在这里，方便管理员查看历史。
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleCreateReminder}
                    className="self-start rounded-lg bg-blue-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-600 sm:self-auto"
                  >
                    新建事项
                  </button>
                </div>
                <div className="space-y-3">
                  {orderedReminderDrafts.map((reminder) => {
                    const ended = new Date(reminder.endAt).getTime() <= Date.now()
                    const expanded = expandedReminderIds.includes(reminder.id)
                    const unreadEnded = isCompletedReminderUnread(reminder)
                    return (
                      <div
                        key={reminder.id}
                        className="space-y-3 rounded-2xl border border-gray-200/70 bg-white/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.04]"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                              ended
                                ? 'bg-red-50 text-red-500 dark:bg-red-500/10 dark:text-red-300'
                                : reminder.enabled
                                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                                  : 'bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400'
                            }`}>
                              {ended ? '已结束' : reminder.enabled ? '进行中' : '已关闭'}
                            </span>
                            <span className="text-xs text-gray-400 dark:text-gray-500">
                              {formatReminderAudience(reminder)} · 每天最多提醒 {reminder.maxDailyShows} 次
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                            <button
                              type="button"
                              onClick={() => toggleReminderExpanded(reminder.id)}
                              className="relative rounded-lg bg-gray-100 px-2 py-1 text-xs font-medium text-gray-500 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                            >
                              {expanded ? '收起' : '展开'}
                              {unreadEnded && !expanded && (
                                <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500" />
                              )}
                            </button>
                            {!ended && (
                              <Switch
                                checked={reminder.enabled}
                                onChange={(checked) => handleUpdateReminder(reminder.id, { enabled: checked })}
                              />
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeleteReminder(reminder.id)}
                              className="rounded-lg bg-red-50 px-2 py-1 text-xs font-medium text-red-500 transition hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                            >
                              删除
                            </button>
                          </div>
                        </div>
                        {!expanded ? (
                          <div className="rounded-xl bg-gray-50/80 px-3 py-2 text-xs leading-5 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                            <div className="font-medium text-gray-700 dark:text-gray-200">{reminder.title || '未命名事项'}</div>
                            <div className="mt-1 break-words whitespace-pre-wrap">
                              {reminder.message.trim() ? renderTextWithLinks(reminder.message.trim()) : '无正文'}
                            </div>
                          </div>
                        ) : ended ? (
                          <div className="space-y-3">
                            <div className="rounded-xl bg-gray-50/80 px-3 py-2 text-xs leading-5 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                              <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">事项标题</div>
                              <div className="mt-1 text-sm font-medium text-gray-700 dark:text-gray-200">{reminder.title || '未命名事项'}</div>
                            </div>
                            <div className="rounded-xl bg-gray-50/80 px-3 py-2 text-xs leading-6 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                              <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">事项正文</div>
                              <div className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-200">
                                {reminder.message.trim() ? renderTextWithLinks(reminder.message.trim()) : '无正文'}
                              </div>
                            </div>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              <div className="rounded-xl bg-gray-50/80 px-3 py-2 text-xs leading-5 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                                <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">开始时间</div>
                                <div className="mt-1 text-sm text-gray-700 dark:text-gray-200">{reminder.startAt.replace('T', ' ')}</div>
                              </div>
                              <div className="rounded-xl bg-gray-50/80 px-3 py-2 text-xs leading-5 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                                <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">结束时间</div>
                                <div className="mt-1 text-sm text-gray-700 dark:text-gray-200">{reminder.endAt.replace('T', ' ')}</div>
                              </div>
                            </div>
                            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4">
                              <div className="min-w-0 rounded-xl bg-gray-50/80 px-3 py-2 text-xs leading-5 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                                <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">投放对象</div>
                                <div className="mt-1 text-sm text-gray-700 dark:text-gray-200">{formatReminderAudience(reminder)}</div>
                              </div>
                              <div className="min-w-0 rounded-xl bg-gray-50/80 px-3 py-2 text-xs leading-5 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                                <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">每天提醒次数</div>
                                <div className="mt-1 text-sm text-gray-700 dark:text-gray-200">{reminder.maxDailyShows}</div>
                              </div>
                              <div className="min-w-0 rounded-xl bg-gray-50/80 px-3 py-2 text-xs leading-5 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                                <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">日内开始</div>
                                <div className="mt-1 text-sm text-gray-700 dark:text-gray-200">{reminder.startTime}</div>
                              </div>
                              <div className="min-w-0 rounded-xl bg-gray-50/80 px-3 py-2 text-xs leading-5 text-gray-500 dark:bg-white/[0.03] dark:text-gray-400">
                                <div className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">日内结束</div>
                                <div className="mt-1 text-sm text-gray-700 dark:text-gray-200">{reminder.endTime}</div>
                              </div>
                            </div>
                            {reminder.imageDataUrls?.length ? (
                              <div className="space-y-2">
                                <span className="block text-xs text-gray-500 dark:text-gray-400">事项配图</span>
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                  {reminder.imageDataUrls.map((imageDataUrl, imageIndex) => (
                                    <img
                                      key={`${reminder.id}-readonly-image-${imageIndex}`}
                                      src={imageDataUrl}
                                      alt={`${reminder.title || '事项配图'} ${imageIndex + 1}`}
                                      className="max-h-36 w-full rounded-2xl object-contain"
                                    />
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">事项标题</span>
                          <ClearableInput
                            value={reminder.title}
                            onChange={(event) => handleUpdateReminder(reminder.id, { title: event.target.value })}
                            onClear={() => handleUpdateReminder(reminder.id, { title: '' })}
                            placeholder="数据备份提醒"
                            className="w-full rounded-xl border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">事项正文</span>
                          <ClearableTextarea
                            value={reminder.message}
                            onChange={(event) => handleUpdateReminder(reminder.id, { message: event.target.value })}
                            onClear={() => handleUpdateReminder(reminder.id, { message: '' })}
                            rows={4}
                            placeholder="请先导出图片和视频，再准备后续清理。"
                            className="w-full rounded-xl border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                          />
                        </label>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <label className="block">
                            <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">开始时间</span>
                            <ClearableInput
                              value={reminder.startAt}
                              onChange={(event) => handleUpdateReminder(reminder.id, { startAt: event.target.value })}
                              onClear={() => handleUpdateReminder(reminder.id, { startAt: '' })}
                              type="datetime-local"
                              className="w-full rounded-xl border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">结束时间</span>
                            <ClearableInput
                              value={reminder.endAt}
                              onChange={(event) => handleUpdateReminder(reminder.id, { endAt: event.target.value })}
                              onClear={() => handleUpdateReminder(reminder.id, { endAt: '' })}
                              type="datetime-local"
                              className="w-full rounded-xl border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                            />
                          </label>
                        </div>
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4">
                          <label className="block min-w-0">
                            <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">投放对象</span>
                            <Select
                              value={getReminderAudienceValue(reminder)}
                              onChange={(value) => handleUpdateReminder(reminder.id, { audienceTiers: getReminderAudienceTiers(value as ReminderAudienceValue) })}
                              options={[
                                { value: 'all', label: '全部用户' },
                                { value: 'free', label: '免费用户' },
                                { value: 'paid', label: '付费用户' },
                              ]}
                              className="w-full min-w-0 rounded-xl border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                            />
                          </label>
                          <label className="block min-w-0">
                            <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">每天提醒次数</span>
                            <ClearableInput
                              value={reminder.maxDailyShows}
                              onChange={(event) => handleUpdateReminder(reminder.id, {
                                maxDailyShows: Math.min(24, Math.max(1, Number(event.target.value) || 1)),
                              })}
                              onClear={() => handleUpdateReminder(reminder.id, { maxDailyShows: 1 })}
                              type="number"
                              min={1}
                              max={24}
                              className="w-full min-w-0 rounded-xl border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                            />
                          </label>
                          <label className="block min-w-0">
                            <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">日内开始</span>
                            <ClearableInput
                              value={reminder.startTime}
                              onChange={(event) => handleUpdateReminder(reminder.id, { startTime: event.target.value })}
                              onClear={() => handleUpdateReminder(reminder.id, { startTime: '' })}
                              type="time"
                              className="w-full min-w-0 rounded-xl border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                            />
                          </label>
                          <label className="block min-w-0">
                            <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">日内结束</span>
                            <ClearableInput
                              value={reminder.endTime}
                              onChange={(event) => handleUpdateReminder(reminder.id, { endTime: event.target.value })}
                              onClear={() => handleUpdateReminder(reminder.id, { endTime: '' })}
                              type="time"
                              className="w-full min-w-0 rounded-xl border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                            />
                          </label>
                        </div>
                        <div className="space-y-2">
                          <span className="block text-xs text-gray-500 dark:text-gray-400">事项配图</span>
                          <textarea
                            value={reminderImageUrlDrafts[reminder.id] ?? ''}
                            onChange={(event) => handleReminderImageUrlChange(reminder.id, event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.stopPropagation()
                              }
                            }}
                            rows={4}
                            className="min-h-[96px] w-full rounded-xl border border-gray-200/70 bg-white/80 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                            placeholder={'每行一个公开图片链接\nhttps://example.com/a.jpg\nhttps://example.com/b.png'}
                          />
                          <div className="text-[11px] text-gray-400 dark:text-gray-500">
                            支持粘贴多张公开图片链接。每行一个。最多保留 16 张。下方会直接预览。
                          </div>
                          {reminder.imageDataUrls?.length ? (
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                {reminder.imageDataUrls.map((imageDataUrl, imageIndex) => (
                                  <div
                                    key={`${reminder.id}-editable-image-${imageIndex}`}
                                    className="relative overflow-hidden rounded-2xl border border-gray-200/70 bg-white/60 p-2 dark:border-white/[0.08] dark:bg-white/[0.03]"
                                  >
                                    <img
                                      src={imageDataUrl}
                                      alt={`${reminder.title || '事项配图'} ${imageIndex + 1}`}
                                      className="max-h-32 w-full rounded-xl object-contain"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveReminderImage(reminder.id, imageIndex)}
                                      className="absolute right-3 top-3 rounded-full bg-black/45 px-2 py-1 text-[11px] font-medium text-white transition hover:bg-black/65"
                                    >
                                      删除
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                          </>
                        )}
                      </div>
                    )
                  })}
                  {!reminderDrafts.length && (
                    <div className="rounded-xl border border-dashed border-gray-200/70 bg-white/40 px-3 py-6 text-center text-xs text-gray-400 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-500">
                      暂无提醒事项
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleSaveReminders()}
                  disabled={isSavingReminders}
                  className="w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSavingReminders ? '保存中...' : '保存提醒事项'}
                </button>
              </div>

              <div className="rounded-2xl border border-gray-200/70 bg-gray-50/60 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_5rem]">
                  <ClearableInput
                    value={newCodeName}
                    onChange={(event) => setNewCodeName(event.target.value)}
                    onClear={() => setNewCodeName('')}
                    placeholder="使用码名称"
                    className="rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                  />
                  <button
                    type="button"
                    onClick={handleCreateUsageCode}
                    className="rounded-xl bg-blue-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
                  >
                    生成
                  </button>
                </div>
                {latestPlainCode && (
                  <div className="mt-3 flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm dark:bg-black/20">
                    <span className="shrink-0 text-gray-500 dark:text-gray-400">新使用码：</span>
                    <button
                      type="button"
                      onClick={() => {
                        void copyTextToClipboard(latestPlainCode)
                          .then(() => useStore.getState().showToast('新使用码已复制', 'success'))
                          .catch((err) => useStore.getState().showToast(getClipboardFailureMessage('复制失败', err), 'error'))
                      }}
                      className="min-w-0 flex-1 truncate rounded-lg bg-gray-50 px-2 py-1 text-left font-mono font-semibold tracking-wide text-gray-900 transition hover:bg-gray-100 dark:bg-white/[0.04] dark:text-gray-100 dark:hover:bg-white/[0.08]"
                      title="点击复制新使用码"
                    >
                      {latestPlainCode}
                    </button>
                  </div>
                )}
                <label className="mt-3 block">
                  <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">用户类型</span>
                  <Select
                    value={newCodeUserTier}
                    onChange={(value) => setNewCodeUserTier(value as BackendUsageCodeUserTier)}
                    options={[
                      { value: 'free', label: '免费用户' },
                      { value: 'paid', label: '付费用户' },
                    ]}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                  />
                </label>
                {profiles.length > 0 && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <span className="mb-2 block text-xs text-gray-500 dark:text-gray-400">允许调用的 API 配置</span>
                      <div className="flex flex-wrap gap-2">
                        {(() => {
                          const selectedIds = Array.isArray(newCodeAllowedProviderProfileIds) ? newCodeAllowedProviderProfileIds : null
                          const allSelected = newCodeAllowedProviderProfileIds === null
                            || (
                              selectedIds !== null
                              && selectedIds.length === profiles.length
                              && profiles.every((profile) => selectedIds.includes(profile.id))
                            )
                          return (
                        <button
                          type="button"
                          onClick={() => setNewCodeAllowedProviderProfileIds(allSelected ? [] : null)}
                          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                            allSelected
                              ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                              : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/[0.05] dark:text-gray-400 dark:hover:bg-white/[0.08]'
                          }`}
                        >
                          全部可用
                        </button>
                          )
                        })()}
                        {profiles.map((profile) => {
                          const selected = newCodeAllowedProviderProfileIds?.includes(profile.id) ?? false
                          const nextIds = selected
                            ? (newCodeAllowedProviderProfileIds ?? []).filter((id) => id !== profile.id)
                            : [...(newCodeAllowedProviderProfileIds ?? []), profile.id]
                          return (
                            <button
                              key={profile.id}
                              type="button"
                              onClick={() => setNewCodeAllowedProviderProfileIds(nextIds.length ? nextIds : [])}
                              className="transition"
                            >
                              <ProviderProfileTag
                                name={profile.name}
                                remarkName={profile.remarkName}
                                preferRemarkName
                                colorKey={profile.id}
                                tagColor={profile.tagColor}
                                apiMode={profile.apiMode}
                                includeMode={false}
                                includeDefault={false}
                                disabled={!selected}
                                crossed={!selected}
                                className={`max-w-[10rem] ${selected ? '' : 'hover:opacity-60'}`}
                              />
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    <div>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="block text-xs text-gray-500 dark:text-gray-400">端点图片额度</span>
                      </div>
                      <div className="space-y-2">
                        {getQuotaEditorProfiles(newCodeAllowedProviderProfileIds, 'image').map((profile) => (
                          <label key={profile.id} className="flex items-center gap-3">
                            <span className="w-24 shrink-0 truncate text-xs text-gray-500 dark:text-gray-400">
                              {profile.name}
                            </span>
                            <ClearableInput
                              value={newCodeProviderImageQuotas[profile.id] ?? ''}
                              onChange={(event) => {
                                const value = event.target.value
                                const nextProviderImageQuotas = {
                                  ...newCodeProviderImageQuotas,
                                  [profile.id]: value,
                                }
                                setNewCodeProviderImageQuotas(nextProviderImageQuotas)
                              }}
                              onClear={() => setNewCodeProviderImageQuotas((prev) => ({
                                ...prev,
                                [profile.id]: '',
                              }))}
                              onBlur={() => {
                                const quota = calculateQuotaExpression(newCodeProviderImageQuotas[profile.id] ?? '', 0)
                                if (quota === undefined) {
                                  useStore.getState().showToast('端点图片额度表达式无效', 'error')
                                  return
                                }
                                setNewCodeProviderImageQuotas((prev) => ({
                                  ...prev,
                                  [profile.id]: quota == null ? '' : String(quota),
                                }))
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur()
                              }}
                              inputMode="numeric"
                              placeholder="0 表示禁用"
                              className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                            />
                          </label>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                        每个图片 API 独立设置。留空按 0 保存。
                      </p>
                    </div>
                    <div>
                      <span className="mb-2 block text-xs text-gray-500 dark:text-gray-400">端点视频额度</span>
                      <div className="space-y-2">
                        {getQuotaEditorProfiles(newCodeAllowedProviderProfileIds, 'video').map((profile) => (
                          <label key={profile.id} className="flex items-center gap-3">
                            <span className="w-24 shrink-0 truncate text-xs text-gray-500 dark:text-gray-400">
                              {profile.name}
                            </span>
                            <ClearableInput
                              value={newCodeProviderVideoQuotas[profile.id] ?? ''}
                              onChange={(event) => {
                                setNewCodeProviderVideoQuotas((prev) => ({
                                  ...prev,
                                  [profile.id]: event.target.value,
                                }))
                              }}
                              onClear={() => setNewCodeProviderVideoQuotas((prev) => ({
                                ...prev,
                                [profile.id]: '',
                              }))}
                              onBlur={() => {
                                const quota = calculateQuotaExpression(newCodeProviderVideoQuotas[profile.id] ?? '', 0)
                                if (quota === undefined) {
                                  useStore.getState().showToast('端点视频额度表达式无效', 'error')
                                  return
                                }
                                setNewCodeProviderVideoQuotas((prev) => ({
                                  ...prev,
                                  [profile.id]: quota == null ? '' : String(quota),
                                }))
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur()
                              }}
                              inputMode="numeric"
                              placeholder="0 表示禁用"
                              className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                            />
                          </label>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                        每个视频 API 独立设置。留空按 0 保存。
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <ClearableInput
                  value={usageCodeSearchQuery}
                  onChange={(event) => setUsageCodeSearchQuery(event.target.value)}
                  onClear={() => setUsageCodeSearchQuery('')}
                  placeholder="搜索使用码或别名"
                  className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                />
                {filteredUsageCodes.map((code) => {
                  const imageQuotaEditorProfiles = getQuotaEditorProfiles(code.allowedProviderProfileIds, 'image')
                  const videoQuotaEditorProfiles = getQuotaEditorProfiles(code.allowedProviderProfileIds, 'video')
                  const isExpanded = expandedUsageCodeIds.includes(code.id)
                  const enabledProfiles = getEnabledProfilesForUsageCode(code.allowedProviderProfileIds)
                  const legacyImageUsageCount = getLegacyImageUsageCount(code)
                  return (
                    <div
                      key={code.id}
                      className="rounded-2xl border border-gray-200/70 bg-white/60 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]"
                    >
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          onClick={() => toggleUsageCodeExpanded(code.id)}
                          className="mt-0.5 rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                          title={isExpanded ? '收起设置' : '展开设置'}
                        >
                          <svg className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <ClearableInput
                                value={code.name}
                                onChange={(event) => {
                                  const name = event.target.value
                                  setUsageCodes((prev) => prev.map((item) => item.id === code.id ? { ...item, name } : item))
                                }}
                                onClear={() => setUsageCodes((prev) => prev.map((item) => item.id === code.id ? { ...item, name: '' } : item))}
                                onBlur={() => handleUpdateUsageCode(code.id, { name: code.name.trim() || '未命名使用码' })}
                                className="w-full rounded-lg bg-transparent pr-2 text-sm font-medium text-gray-800 outline-none dark:text-gray-100"
                              />
                              <div className="mt-1">
                                <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                  code.userTier === 'paid'
                                    ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300'
                                    : 'bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-300'
                                }`}>
                                  {formatUsageCodeUserTier(code.userTier)}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                <span>{`任务 ${code.taskCount} · 已生成图片 ${code.outputImageCount}`}</span>
                                {legacyImageUsageCount > 0 && (
                                  <span className="ml-1 whitespace-nowrap text-[11px] text-gray-400 dark:text-gray-500">
                                    {`（旧额 ${legacyImageUsageCount}）`}
                                  </span>
                                )}
                                <span>{` · 已生成视频 ${code.outputVideoCount}`}</span>
                              </p>
                              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                                最近使用：{code.lastUsedAt ? new Date(code.lastUsedAt).toLocaleString('zh-CN') : '从未使用'}
                              </p>
                            </div>
                            <Switch
                              checked={code.isEnabled}
                              onChange={(checked) => handleUpdateUsageCode(code.id, { isEnabled: checked })}
                            />
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {enabledProfiles.length > 0 ? enabledProfiles.map((profile) => (
                              (() => {
                                const providerStats = getUsageCodeProviderStats(code, profile)
                                return (
                                  <ProviderProfileTag
                                    key={profile.id}
                                    name={profile.name}
                                    remarkName={profile.remarkName}
                                    preferRemarkName
                                    colorKey={profile.id}
                                    tagColor={profile.tagColor}
                                    apiMode={profile.apiMode}
                                    isDefault={Boolean(profile.isDefault)}
                                    includeMode={false}
                                    includeDefault={false}
                                    text={`${getAdminProviderName(profile)} ${providerStats.usedCount}/${providerStats.availableText}`}
                                    detail={
                                      <div>
                                        <div className="font-medium text-gray-800 dark:text-gray-100">{getAdminProviderName(profile)}</div>
                                        <div className="mt-1 whitespace-nowrap text-[11px] text-gray-600 dark:text-gray-300">
                                          总额度 {providerStats.totalText} 已用 {providerStats.usedCount} 可用 {providerStats.availableDetailText}
                                        </div>
                                      </div>
                                    }
                                    content={(
                                      <span className="flex min-w-0 items-baseline gap-1">
                                        <span className="truncate">{profile.name}</span>
                                        <span className="shrink-0 text-[9px] font-medium tabular-nums text-current/55">
                                          {providerStats.usedCount}/{providerStats.totalText}
                                        </span>
                                      </span>
                                    )}
                                    compact
                                    className="max-w-[14rem] brightness-90"
                                  />
                                )
                              })()
                            )) : (
                              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500 dark:bg-white/[0.05] dark:text-gray-400">
                                未启用 API
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                if (!code.code) return
                                void copyTextToClipboard(code.code)
                                  .then(() => useStore.getState().showToast('使用码已复制', 'success'))
                                  .catch((err) => useStore.getState().showToast(getClipboardFailureMessage('复制失败', err), 'error'))
                              }}
                              className="rounded-lg bg-gray-100 px-2 py-1 font-mono text-xs text-gray-800 transition hover:bg-gray-200 dark:bg-black/20 dark:text-gray-100 dark:hover:bg-black/30"
                            >
                              {code.code ?? '旧使用码无法恢复'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteUsageCode(code)}
                              className="rounded-lg bg-red-50 px-2 py-1 text-xs font-medium text-red-500 transition hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                            >
                              删除
                            </button>
                          </div>
                          {isExpanded && (
                            <>
                              <label className="mt-3 block">
                                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">用户类型</span>
                                <Select
                                  value={code.userTier}
                                  onChange={(value) => void handleUpdateUsageCode(code.id, { userTier: value as BackendUsageCodeUserTier })}
                                  options={[
                                    { value: 'free', label: '免费用户' },
                                    { value: 'paid', label: '付费用户' },
                                  ]}
                                  className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                                />
                              </label>
                              {profiles.length > 0 && (
                                <div className="mt-3">
                                  <span className="mb-2 block text-xs text-gray-500 dark:text-gray-400">允许调用的 API 配置</span>
                                  <div className="flex flex-wrap gap-2">
                                    {(() => {
                                      const selectedIds = Array.isArray(code.allowedProviderProfileIds) ? code.allowedProviderProfileIds : null
                                      const allSelected = code.allowedProviderProfileIds === null
                                        || (
                                          selectedIds !== null
                                          && selectedIds.length === profiles.length
                                          && profiles.every((profile) => selectedIds.includes(profile.id))
                                        )
                                      return (
                                    <button
                                      type="button"
                                      onClick={() => void handleUpdateUsageCode(code.id, { allowedProviderProfileIds: allSelected ? [] : null })}
                                      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                                        allSelected
                                          ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                                          : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/[0.05] dark:text-gray-400 dark:hover:bg-white/[0.08]'
                                      }`}
                                    >
                                      全部可用
                                    </button>
                                      )
                                    })()}
                                    {profiles.map((profile) => {
                                      const selected = code.allowedProviderProfileIds?.includes(profile.id) ?? false
                                      const nextIds = selected
                                        ? (code.allowedProviderProfileIds ?? []).filter((id) => id !== profile.id)
                                        : [...(code.allowedProviderProfileIds ?? []), profile.id]
                                      return (
                                        <button
                                          key={profile.id}
                                          type="button"
                                          onClick={() => void handleUpdateUsageCode(code.id, { allowedProviderProfileIds: nextIds.length ? nextIds : [] })}
                                          className="transition"
                                        >
                                          <ProviderProfileTag
                                            name={profile.name}
                                            remarkName={profile.remarkName}
                                            preferRemarkName
                                            colorKey={profile.id}
                                            tagColor={profile.tagColor}
                                            apiMode={profile.apiMode}
                                            includeMode={false}
                                            includeDefault={false}
                                            disabled={!selected}
                                            crossed={!selected}
                                            className={`max-w-[10rem] ${selected ? '' : 'hover:opacity-60'}`}
                                          />
                                        </button>
                                      )
                                    })}
                                  </div>
                                  <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                                    不选表示该使用码不可调用任何 API 配置。点“全部可用”可恢复不限制。
                                  </p>
                                </div>
                              )}
                              {imageQuotaEditorProfiles.length > 0 && (
                                <div className="mt-3">
                                  <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="block text-xs text-gray-500 dark:text-gray-400">端点图片额度</span>
                                  </div>
                                  <div className="space-y-2">
                                    {imageQuotaEditorProfiles.map((profile) => {
                                      const providerQuotaValue = usageCodeProviderImageQuotaDrafts[code.id]?.[profile.id]
                                        ?? String(code.providerImageQuotas?.[profile.id] ?? 0)
                                      return (
                                        <label key={profile.id} className="block">
                                          <div className="mb-1 flex items-center justify-between gap-3">
                                            <span className="truncate text-xs text-gray-500 dark:text-gray-400">{profile.name}</span>
                                            <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
                                              已用：{code.providerUsedImageCredits?.[profile.id] ?? 0}
                                            </span>
                                          </div>
                                          <ClearableInput
                                            value={providerQuotaValue}
                                            onChange={(event) => setUsageCodeProviderImageQuotaDrafts((prev) => ({
                                              ...prev,
                                              [code.id]: {
                                                ...(prev[code.id] ?? {}),
                                                [profile.id]: event.target.value,
                                              },
                                            }))}
                                            onClear={() => setUsageCodeProviderImageQuotaDrafts((prev) => ({
                                              ...prev,
                                              [code.id]: {
                                                ...(prev[code.id] ?? {}),
                                                [profile.id]: '',
                                              },
                                            }))}
                                            onBlur={() => void handleSubmitProviderQuota(code, profile.id, 'image')}
                                            onKeyDown={(event) => {
                                              if (event.key === 'Enter') event.currentTarget.blur()
                                            }}
                                            inputMode="numeric"
                                            className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                                            placeholder="0 表示禁用"
                                          />
                                        </label>
                                      )
                                    })}
                                  </div>
                                  <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                                    每个图片 API 独立扣减。填 0 表示禁用。
                                  </p>
                                </div>
                              )}
                              {videoQuotaEditorProfiles.length > 0 && (
                                <div className="mt-3">
                                  <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="block text-xs text-gray-500 dark:text-gray-400">端点视频额度</span>
                                  </div>
                                  <div className="space-y-2">
                                    {videoQuotaEditorProfiles.map((profile) => {
                                      const providerQuotaValue = usageCodeProviderVideoQuotaDrafts[code.id]?.[profile.id]
                                        ?? String(code.providerVideoQuotas?.[profile.id] ?? 0)
                                      return (
                                        <label key={profile.id} className="block">
                                          <div className="mb-1 flex items-center justify-between gap-3">
                                            <span className="truncate text-xs text-gray-500 dark:text-gray-400">{profile.name}</span>
                                            <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
                                              已用：{code.providerUsedVideoCredits?.[profile.id] ?? 0}
                                            </span>
                                          </div>
                                          <ClearableInput
                                            value={providerQuotaValue}
                                            onChange={(event) => setUsageCodeProviderVideoQuotaDrafts((prev) => ({
                                              ...prev,
                                              [code.id]: {
                                                ...(prev[code.id] ?? {}),
                                                [profile.id]: event.target.value,
                                              },
                                            }))}
                                            onClear={() => setUsageCodeProviderVideoQuotaDrafts((prev) => ({
                                              ...prev,
                                              [code.id]: {
                                                ...(prev[code.id] ?? {}),
                                                [profile.id]: '',
                                              },
                                            }))}
                                            onBlur={() => void handleSubmitProviderQuota(code, profile.id, 'video')}
                                            onKeyDown={(event) => {
                                              if (event.key === 'Enter') event.currentTarget.blur()
                                            }}
                                            inputMode="numeric"
                                            className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                                            placeholder="0 表示禁用"
                                          />
                                        </label>
                                      )
                                    })}
                                  </div>
                                  <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                                    每个视频 API 独立扣减。填 0 表示禁用。
                                  </p>
                                </div>
                              )}
                              <div className="mt-4">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                  <span className="block text-xs text-gray-500 dark:text-gray-400">行为记录</span>
                                  <button
                                    type="button"
                                    onClick={() => openUsageCodeEventModal(code)}
                                    className="rounded-lg bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-600 transition hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20"
                                  >
                                    完整查询
                                  </button>
                                </div>
                                {code.activityEvents.length > 0 ? (
                                  <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-gray-200/70 bg-white/40 p-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
                                    {code.activityEvents.map((event) => {
                                      const accessActivity = parseUsageCodeAccessActivity(event)
                                      return (
                                        <div key={event.id} className="rounded-lg bg-white/70 px-3 py-2 text-xs dark:bg-white/[0.04]">
                                          <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0 flex-1 text-gray-800 dark:text-gray-100">
                                              {accessActivity ? (
                                                <div className="space-y-2">
                                                  <div>{accessActivity.kind === 'created' ? '管理员创建使用码' : '管理员调整可用 API'}</div>
                                                  <div className="space-y-1">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                      <span className="text-[11px] text-gray-400 dark:text-gray-500">启用</span>
                                                      {renderUsageCodeAccessTags(accessActivity.enabledLabel)}
                                                    </div>
                                                    {accessActivity.disabledLabel && (
                                                      <div className="flex flex-wrap items-center gap-2">
                                                        <span className="text-[11px] text-gray-400 dark:text-gray-500">禁用</span>
                                                        {renderUsageCodeAccessTags(accessActivity.disabledLabel, true)}
                                                      </div>
                                                    )}
                                                  </div>
                                                </div>
                                              ) : (
                                                event.label
                                              )}
                                            </div>
                                            {!accessActivity && event.providerProfileName && (
                                              <ProviderProfileTag
                                                name={event.providerProfileName}
                                                colorKey={event.providerProfileId ?? event.providerProfileName}
                                                tagColor={event.providerProfileTagColor}
                                                text={formatActivityEventTagText(event) ?? event.providerProfileName}
                                                includeMode={false}
                                                includeDefault={false}
                                                className="max-w-[8.5rem] shrink-0"
                                              />
                                            )}
                                          </div>
                                          <div className="mt-1 text-gray-400 dark:text-gray-500">
                                            {new Date(event.createdAt).toLocaleString('zh-CN')}
                                            {event.taskId ? ` · 任务 ${event.taskId}` : ''}
                                          </div>
                                        </div>
                                      )
                                    })}
                                  </div>
                                ) : (
                                  <div className="rounded-xl border border-dashed border-gray-200/70 bg-white/30 px-3 py-3 text-xs text-gray-400 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-500">
                                    暂无最近记录
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {!filteredUsageCodes.length && (
                  <div className="rounded-2xl border border-dashed border-gray-200 py-8 text-center text-sm text-gray-400 dark:border-white/[0.08]">
                    {usageCodes.length ? '没有匹配的使用码' : '暂无使用码'}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'data' && isAdmin && (
            <div className="space-y-3">
              {shouldShowMaintenanceCard && backupState && (
                <div className="rounded-2xl border border-blue-200/70 bg-blue-50/70 p-4 dark:border-blue-400/20 dark:bg-blue-500/10">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-blue-900 dark:text-blue-100">
                        {backupState.operation === 'backup_import'
                          ? backupState.phase === 'completed'
                            ? '服务器备份恢复已完成'
                            : backupState.phase === 'failed'
                              ? '服务器备份恢复失败'
                              : '正在恢复服务器备份'
                          : backupState.operation === 'backup_export'
                            ? backupState.phase === 'preparing'
                              ? '正在等待任务队列完成'
                              : backupState.phase === 'running'
                                ? '正在生成服务器备份包'
                                : backupState.phase === 'completed'
                                  ? '服务器备份已完成'
                                  : '服务器备份失败'
                            : backupState.operation === 'remote_reset_usage_code'
                              ? backupState.phase === 'completed'
                                ? '使用码任务与产物已清理完成'
                                : backupState.phase === 'failed'
                                  ? '使用码任务与产物清理失败'
                                  : '正在清理使用码任务与产物'
                              : backupState.operation === 'remote_reset_all'
                                ? backupState.phase === 'completed'
                                  ? '远端全部数据已清空'
                                  : backupState.phase === 'failed'
                                    ? '远端全部数据清空失败'
                                    : '正在清空远端全部'
                                : backupState.phase === 'completed'
                                  ? '远端记录已清空'
                                  : backupState.phase === 'failed'
                                    ? '远端记录清空失败'
                                    : '正在清空远端记录'}
                      </div>
                      <div className="mt-1 break-all text-xs leading-5 text-blue-700/90 dark:text-blue-200/80">
                        {backupState.error || backupState.message}
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-blue-800 dark:text-blue-100">{backupState.progressPercent}%</div>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-200/70 dark:bg-white/10">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
                      style={{ width: `${Math.max(4, backupState.progressPercent)}%` }}
                    />
                  </div>
                  <div className="mt-3 text-xs leading-5 text-blue-700/90 dark:text-blue-200/80">
                    {backupState.operation === 'backup_import'
                      ? '恢复期间普通用户与管理员写入操作都会暂停。'
                      : backupState.operation?.startsWith('remote_reset_')
                        ? backupState.phase === 'preparing'
                          ? `执行中 ${backupState.waitingRunningTasks} 个，排队中 ${backupState.waitingPendingTasks} 个`
                          : `已处理 ${backupState.processedFiles}/${backupState.totalFiles} 个步骤，${formatBytes(backupState.processedBytes)}/${formatBytes(backupState.totalBytes)}`
                      : backupState.phase === 'preparing'
                        ? `执行中 ${backupState.waitingRunningTasks} 个，排队中 ${backupState.waitingPendingTasks} 个`
                        : `已处理 ${backupState.processedFiles}/${backupState.totalFiles} 个文件，${formatBytes(backupState.processedBytes)}/${formatBytes(backupState.totalBytes)}`}
                  </div>
                  {backupState.filePath && (
                    <div className="mt-2 break-all text-xs leading-5 text-blue-700/90 dark:text-blue-200/80">
                      {backupState.filePath}
                    </div>
                  )}
                </div>
              )}
              <div className="rounded-2xl border border-gray-200/80 bg-white/50 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100">数据管理操作日志</div>
                <div className="mt-3 space-y-2">
                  {managementLogs.length ? managementLogs.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-gray-200/70 bg-gray-50/70 px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.03]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 break-words text-sm text-gray-800 dark:text-gray-100">{item.title}</div>
                        <div className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{formatLocalDateTime(item.createdAt)}</div>
                      </div>
                      <div className="mt-1 break-all text-xs leading-5 text-gray-500 dark:text-gray-400">{item.detail}</div>
                    </div>
                  )) : (
                    <div className="text-xs leading-5 text-gray-500 dark:text-gray-400">最近还没有数据管理操作日志。</div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={handleExportBackup}
                  disabled={isExporting || isImporting || isClearingRemote || Boolean(backupState?.active)}
                  className="rounded-xl border border-gray-200/80 bg-gray-50/60 px-4 py-2.5 text-sm text-gray-700 transition hover:bg-gray-100/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                >
                  {isExporting ? '提交中...' : backupState?.active ? '备份进行中' : '生成服务器备份包'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleLoadImportCandidates()}
                  disabled={isImporting || isExporting || isClearingRemote || Boolean(backupState?.active)}
                  className="rounded-xl border border-gray-200/80 bg-gray-50/60 px-4 py-2.5 text-sm text-gray-700 transition hover:bg-gray-100/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                >
                  {isImporting ? '读取中...' : '选择并恢复备份'}
                </button>
              </div>
              <div className="rounded-xl border border-dashed border-gray-200/80 bg-white/40 px-3 py-2 text-xs leading-5 text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-400">
                每次服务器备份都会写入 `backups/备份批次目录/`。大体积备份会拆成引导文件和多个分包。恢复本地分包时，需要把同一目录内的 `.index.json` 和全部 `.zip` 一起上传。
              </div>
              {showImportCandidates && (
                <div className="space-y-3 rounded-xl border border-gray-200/80 bg-white/50 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-100">可导入的服务器备份目录</div>
                    <button
                      type="button"
                      onClick={() => importInputRef.current?.click()}
                      disabled={isImporting || isExporting || isClearingRemote}
                      className="rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      上传本地备份组
                    </button>
                  </div>
                  {importCandidates.length ? (
                    <div className="space-y-2">
                      {importCandidates.map((item) => (
                        <div
                          key={item.filePath}
                          className="rounded-lg border border-gray-200/70 bg-white/70 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.04]"
                        >
                          <div className="break-all text-sm font-medium text-gray-800 dark:text-gray-100">{item.displayName || item.fileName}</div>
                          <div className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
                            <div>修改时间：{formatLocalDateTime(item.modifiedAt)}</div>
                            <div>文件大小：{formatBytes(item.bytes)}</div>
                            {item.kind === 'split' && (
                              <>
                                <div>引导文件：{item.fileName}</div>
                                <div>
                                  分包情况：{item.foundPartCount}/{item.partCount}
                                  {item.missingPartNames?.length ? ` · 缺少 ${item.missingPartNames.join('、')}` : ' · 已齐全'}
                                </div>
                              </>
                            )}
                          </div>
                          <div className="mt-2 flex justify-end">
                            <button
                              type="button"
                              onClick={() => void handleImportServerBackup(item.filePath)}
                              disabled={isImporting || isExporting || isClearingRemote || Boolean(item.missingPartNames?.length)}
                              className="rounded-lg border border-gray-200/80 bg-gray-50/80 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]"
                            >
                              {isImporting ? '恢复中...' : item.kind === 'split' ? '恢复这组备份' : '从该文件恢复'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs leading-5 text-gray-500 dark:text-gray-400">
                      服务器备份目录中还没有可导入的备份批次。可以先上传本地备份组。
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() =>
                  setConfirmDialog({
                    title: '清除全部使用码任务与产物',
                    message: '这会删除所有使用码用户提交的任务卡片，以及这些任务对应的输入图、遮罩图、输出图、视频和缩略图，用于释放服务器硬盘空间。\n\n不会删除管理员任务。不会删除使用码、配额记录、活动日志、API 配置或分发设置。',
                    confirmText: '确认清除',
                    tone: 'danger',
                    action: () => {
                      void handleResetRemoteData('usage_code_tasks_only')
                    },
                  })
                }
                disabled={isClearingRemote || isImporting || isExporting || Boolean(backupState?.active)}
                className="w-full rounded-xl border border-amber-200/80 bg-amber-50/50 px-4 py-2.5 text-sm text-amber-700 transition hover:bg-amber-100/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
              >
                {isClearingRemote || backupState?.active ? '清理进行中...' : '清除全部使用码任务与产物'}
              </button>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setConfirmDialog({
                      title: '清空远端任务与图片',
                      message: '这会删除后端数据库中的全部任务记录，以及后端媒体目录中的输入图、遮罩图、输出图和缩略图。\n\n后端运行配置会保留。',
                      confirmText: '确认清空',
                      tone: 'danger',
                      action: () => {
                        void handleResetRemoteData('tasks')
                      },
                    })
                  }
                  disabled={isClearingRemote || isImporting || isExporting || Boolean(backupState?.active)}
                  className="rounded-xl border border-orange-200/80 bg-orange-50/50 px-4 py-2.5 text-sm text-orange-600 transition hover:bg-orange-100/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-300 dark:hover:bg-orange-500/20"
                >
                  {isClearingRemote || backupState?.active ? '清理进行中...' : '清空远端记录'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setConfirmDialog({
                      title: '清空远端全部数据',
                      message: '这会删除后端任务记录、全部图片文件，以及后端保存的 API URL、API Key、模型、接口模式等运行配置。',
                      confirmText: '确认全部清空',
                      tone: 'danger',
                      action: () => {
                        void handleResetRemoteData('all')
                      },
                    })
                  }
                  disabled={isClearingRemote || isImporting || isExporting || Boolean(backupState?.active)}
                  className="rounded-xl border border-red-200/80 bg-red-50/50 px-4 py-2.5 text-sm text-red-500 transition hover:bg-red-100/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
                >
                  {isClearingRemote || backupState?.active ? '清理进行中...' : '清空远端全部'}
                </button>
              </div>
              <button
                onClick={() =>
                  setConfirmDialog({
                    title: '清空所有数据',
                    message: '确定要清空当前浏览器的所有任务记录和图片缓存吗？此操作不可恢复。',
                    action: () => clearAllData(),
                  })
                }
                className="w-full rounded-xl border border-red-200/80 bg-red-50/50 px-4 py-2.5 text-sm text-red-500 transition hover:bg-red-100/80 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
              >
                清空本地缓存
              </button>
              <div className="rounded-xl border border-gray-200/70 bg-white/40 px-4 py-3 text-xs leading-6 text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-400">
                {mediaStats
                  ? `媒体统计：图片 ${mediaStats.imageCount} 张，视频 ${mediaStats.videoCount} 个，总大小 ${formatBytes(mediaStats.totalBytes)}`
                  : '媒体统计：读取中...'}
              </div>
              <input
                ref={importInputRef}
                type="file"
                accept=".zip,.json,application/zip,application/json"
                multiple
                className="hidden"
                onChange={handleImportFile}
              />
            </div>
          )}
        </div>

        {(activeTab === 'habits' || (!isAdmin && activeTab === 'api')) && (
          <div className="grid grid-cols-2 gap-2 border-t border-gray-100 px-5 py-4 dark:border-white/[0.08]">
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? '保存中...' : '保存'}
            </button>
          </div>
        )}
      </div>
      {usageCodeEventModal && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div
            className="glass-overlay-soft absolute inset-0"
            onClick={() => setUsageCodeEventModal(null)}
          />
          <div ref={usageCodeEventPanelRef} className="glass-surface-strong relative z-10 flex h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-white/50 shadow-2xl ring-1 ring-black/5 dark:border-white/[0.08] dark:ring-white/10">
            <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-gray-800 dark:text-gray-100">{usageCodeEventModal.code.name} 完整记录</h3>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  最近使用：{usageCodeEventModal.code.lastUsedAt ? formatLocalDateTime(usageCodeEventModal.code.lastUsedAt) : '从未使用'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setUsageCodeEventModal(null)}
                className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                aria-label="关闭完整查询"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="tiny-scrollbar flex-1 overflow-y-auto px-5 py-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
                <label className="block xl:col-span-1">
                  <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">时间范围</span>
                  <Select
                    value={usageCodeEventModal.query.timePreset}
                    onChange={(value) => handleUsageCodeEventPresetChange(value as BackendUsageCodeEventTimePreset)}
                    options={[
                      { value: 'today', label: '今天' },
                      { value: 'yesterday', label: '昨天' },
                      { value: 'last7days', label: '近 7 天' },
                      { value: 'last30days', label: '近 30 天' },
                      { value: 'custom', label: '自定义' },
                    ]}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                </label>
                <label className="block xl:col-span-1">
                  <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">开始时间</span>
                  <input
                    type="datetime-local"
                    value={usageCodeEventModal.query.startAt}
                    onChange={(event) => updateUsageCodeEventQuery({ startAt: event.target.value })}
                    disabled={usageCodeEventModal.query.timePreset !== 'custom'}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                </label>
                <label className="block xl:col-span-1">
                  <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">结束时间</span>
                  <input
                    type="datetime-local"
                    value={usageCodeEventModal.query.endAt}
                    onChange={(event) => updateUsageCodeEventQuery({ endAt: event.target.value })}
                    disabled={usageCodeEventModal.query.timePreset !== 'custom'}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                </label>
                <label className="block xl:col-span-1">
                  <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">时间粒度</span>
                  <Select
                    value={usageCodeEventModal.query.bucket}
                    onChange={(value) => updateUsageCodeEventQuery({ bucket: value as BackendUsageCodeEventBucket })}
                    options={[
                      { value: 'month', label: '按月' },
                      { value: 'day', label: '按日' },
                      { value: 'hour', label: '按小时' },
                      { value: '30m', label: '按 30 分钟' },
                      { value: '15m', label: '按 15 分钟' },
                      { value: '5m', label: '按 5 分钟' },
                    ]}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                </label>
                <label className="block xl:col-span-1">
                  <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">事件类型</span>
                  <div className="md:hidden flex flex-wrap gap-2 rounded-xl border border-gray-200/70 bg-white/40 p-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
                    {categoryOptions.map((item) => {
                      const selected = usageCodeEventModal.query.eventCategories.includes(item.value)
                      return (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => toggleUsageCodeEventCategory(item.value)}
                          className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                            selected
                              ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                              : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/[0.05] dark:text-gray-400 dark:hover:bg-white/[0.08]'
                          }`}
                        >
                          {item.label}
                        </button>
                      )
                    })}
                  </div>
                  <div ref={usageCodeEventCategoryMenuRef} className="relative hidden md:block">
                    <button
                      type="button"
                      onClick={() => setIsUsageCodeEventCategoryMenuOpen((prev) => !prev)}
                      className="flex w-full items-center justify-between gap-2 rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.08]"
                    >
                      <span className="min-w-0 flex-1 truncate text-left">
                        {getUsageCodeEventCategoryMenuLabel(usageCodeEventModal.query.eventCategories)}
                      </span>
                      <svg
                        className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform dark:text-gray-500 ${isUsageCodeEventCategoryMenuOpen ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isUsageCodeEventCategoryMenuOpen && (
                      <div className="absolute left-0 right-0 top-full z-20 mt-2 max-h-72 overflow-y-auto rounded-2xl border border-gray-200/70 bg-white/95 p-2 shadow-[0_12px_36px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur dark:border-white/[0.08] dark:bg-[#1d1d1f]/95 dark:ring-white/10">
                        <div className="space-y-1">
                          {categoryOptions.map((item) => {
                            const selected = usageCodeEventModal.query.eventCategories.includes(item.value)
                            return (
                              <button
                                key={item.value}
                                type="button"
                                onClick={() => toggleUsageCodeEventCategory(item.value)}
                                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition ${
                                  selected
                                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/[0.06]'
                                }`}
                              >
                                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                  selected
                                    ? 'border-blue-500 bg-blue-500 text-white dark:border-blue-400 dark:bg-blue-400'
                                    : 'border-gray-300 text-transparent dark:border-white/[0.18]'
                                }`}>
                                  <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                  </svg>
                                </span>
                                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </label>
                <label className="block xl:col-span-1">
                  <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">任务号</span>
                  <ClearableInput
                    value={usageCodeEventModal.query.taskId}
                    onChange={(event) => updateUsageCodeEventQuery({ taskId: event.target.value })}
                    onClear={() => updateUsageCodeEventQuery({ taskId: '' })}
                    placeholder="输入完整任务号"
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => runCurrentUsageCodeEventQuery(1)}
                  disabled={usageCodeEventModal.loading}
                  className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {usageCodeEventModal.loading ? '查询中...' : '查询'}
                </button>
                <button
                  type="button"
                  onClick={resetUsageCodeEventQuery}
                  disabled={usageCodeEventModal.loading}
                  className="rounded-xl border border-gray-200/70 bg-white/60 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.08]"
                >
                  重置
                </button>
              </div>
              {usageCodeEventModal.loading && !usageCodeEventModal.result && (
                <div className="mt-4 rounded-2xl border border-dashed border-gray-200/70 bg-white/30 px-4 py-8 text-center text-sm text-gray-400 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-500">
                  正在读取记录
                </div>
              )}
              {usageCodeEventModal.result && (
                <>
                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
                    {buildUsageCodeEventSummaryCards(
                      usageCodeEventModal.result.summary,
                      usageCodeEventModal.query.eventCategories,
                    ).map((card) => (
                      <div key={card.key} className="rounded-2xl border border-gray-200/70 bg-white/50 px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                        <div className="text-xs text-gray-500 dark:text-gray-400">{card.title}</div>
                        <div className="mt-1 text-lg font-semibold text-gray-800 dark:text-gray-100">{card.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 space-y-3">
                    {usageCodeEventModal.result.groups.length > 0 ? usageCodeEventModal.result.groups.map((group: BackendUsageCodeEventGroup) => {
                      const isExpanded = usageCodeEventModal.expandedGroupKeys.includes(group.bucketKey)
                      return (
                      <div key={group.bucketKey} className="rounded-2xl border border-gray-200/70 bg-white/50 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                        <button
                          type="button"
                          onClick={() => toggleUsageCodeEventGroup(group.bucketKey)}
                          className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <svg className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                            <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{group.bucketLabel}</div>
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {group.eventCount} 条 · {getUsageCodeEventSummaryText(group.summary)}
                          </div>
                        </button>
                        {isExpanded && (
                        <div className="mt-3 space-y-2">
                          {group.items.map((event) => (
                            <div key={event.id} className="rounded-xl bg-white/70 px-3 py-2 text-xs dark:bg-white/[0.04]">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1 text-gray-800 dark:text-gray-100">
                                  {event.label}
                                </div>
                                {event.providerProfileName && (
                                  <ProviderProfileTag
                                    name={event.providerProfileName}
                                    colorKey={event.providerProfileId ?? event.providerProfileName}
                                    tagColor={event.providerProfileTagColor}
                                    text={event.credits == null ? event.providerProfileName : `${event.providerProfileName}：${event.eventCategory === 'quota_increase' ? '+' : event.eventCategory === 'quota_decrease' ? '-' : ''}${event.credits}`}
                                    includeMode={false}
                                    includeDefault={false}
                                    className="max-w-[10rem] shrink-0"
                                  />
                                )}
                              </div>
                              <div className="mt-1 text-gray-400 dark:text-gray-500">
                                {formatLocalDateTime(event.createdAt)}
                                {event.taskId ? ` · 任务 ${event.taskId}` : ''}
                              </div>
                            </div>
                          ))}
                        </div>
                        )}
                      </div>
                      )
                    }) : (
                      <div className="rounded-2xl border border-dashed border-gray-200/70 bg-white/30 px-4 py-8 text-center text-sm text-gray-400 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-500">
                        当前筛选条件下没有记录
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            {usageCodeEventModal.result && (
              <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-5 py-4 text-sm dark:border-white/[0.08]">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  第 {usageCodeEventModal.result.pagination.page}/{usageCodeEventModal.result.pagination.totalPages} 页，共 {usageCodeEventModal.result.pagination.total} 条
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => runCurrentUsageCodeEventQuery(usageCodeEventModal.result!.pagination.page - 1)}
                    disabled={usageCodeEventModal.loading || usageCodeEventModal.result.pagination.page <= 1}
                    className="rounded-xl border border-gray-200/70 bg-white/60 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.08]"
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    onClick={() => runCurrentUsageCodeEventQuery(usageCodeEventModal.result!.pagination.page + 1)}
                    disabled={usageCodeEventModal.loading || usageCodeEventModal.result.pagination.page >= usageCodeEventModal.result.pagination.totalPages}
                    className="rounded-xl border border-gray-200/70 bg-white/60 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.08]"
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </div>
  )
}
