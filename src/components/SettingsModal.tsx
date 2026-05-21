import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { normalizeBaseUrl } from '../lib/devProxy'
import {
  createBackendProviderProfile,
  createBackendUsageCode,
  deleteBackendProviderProfile,
  deleteBackendUsageCode,
  fetchBackendDistribution,
  fetchBackendProviderOptions,
  fetchBackendProviderProfiles,
  fetchBackendRuntimeSettings,
  fetchBackendUsageCodes,
  resetBackendRemoteData,
  saveBackendRuntimePreferences,
  saveBackendDistribution,
  updateBackendProviderProfile,
  updateBackendUsageCode,
  type BackendDistributionSettings,
  type BackendProviderOption,
  type BackendProviderProfile,
  type BackendUsageCode,
} from '../lib/backendSettings'
import { exportBackendBackup, importBackendBackup } from '../lib/backendBackup'
import { addSessionUsageCode } from '../lib/backendAuth'
import { fetchBackendTasks } from '../lib/backendTasks'
import { useStore, clearAllData, clearLocalTaskCache } from '../store'
import { DEFAULT_IMAGES_MODEL, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, type AppSettings } from '../types'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import Select from './Select'
import ProviderProfileTag from './ProviderProfileTag'

type SettingsTab = 'habits' | 'api' | 'data' | 'distribution'

function createEmptyProfile(): BackendProviderProfile {
  return {
    id: '',
    name: '新 API 配置',
    baseUrl: DEFAULT_SETTINGS.baseUrl,
    apiKey: '',
    apiKeyMasked: null,
    apiKeyConfigured: false,
    model: DEFAULT_IMAGES_MODEL,
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
  const [usageCodes, setUsageCodes] = useState<BackendUsageCode[]>([])
  const [newCodeName, setNewCodeName] = useState('新使用码')
  const [newCodeAllowedProviderProfileIds, setNewCodeAllowedProviderProfileIds] = useState<string[] | null>(null)
  const [newCodeProviderImageQuotas, setNewCodeProviderImageQuotas] = useState<Record<string, string>>({})
  const [newCodeProviderVideoQuotas, setNewCodeProviderVideoQuotas] = useState<Record<string, string>>({})
  const [latestPlainCode, setLatestPlainCode] = useState('')
  const [usageCodeProviderImageQuotaDrafts, setUsageCodeProviderImageQuotaDrafts] = useState<Record<string, Record<string, string>>>({})
  const [usageCodeProviderVideoQuotaDrafts, setUsageCodeProviderVideoQuotaDrafts] = useState<Record<string, Record<string, string>>>({})
  const [usageCodeSearchQuery, setUsageCodeSearchQuery] = useState('')
  const [expandedUsageCodeIds, setExpandedUsageCodeIds] = useState<string[]>([])
  const [addCodeValue, setAddCodeValue] = useState('')
  const [activeTab, setActiveTab] = useState<SettingsTab>('habits')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isClearingRemote, setIsClearingRemote] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const getDefaultModelForMode = (apiMode: AppSettings['apiMode']) =>
    apiMode === 'videos' ? 'grok-imagine-video' : apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL

  const selectedProfileId = profileDraft.id || '__new__'
  const isAdmin = authStatus?.role === 'admin'
  const userUsageCodes = authStatus?.usageCodes ?? []
  const filteredUsageCodes = useMemo(() => {
    const query = usageCodeSearchQuery.trim().toLowerCase()
    if (!query) return usageCodes
    return usageCodes.filter((code) =>
      [code.name, code.code ?? '']
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
    if (allowedProviderProfileIds?.length) {
      return profiles.filter((profile) =>
        allowedProviderProfileIds.includes(profile.id)
        && (quotaType === 'video' ? profile.apiMode === 'videos' : profile.apiMode !== 'videos'),
      )
    }
    return profiles.filter((profile) => (quotaType === 'video' ? profile.apiMode === 'videos' : profile.apiMode !== 'videos'))
  }

  const formatQuotaValue = (value: number | null | undefined) => {
    if (value == null) return '不限'
    if (value === 0) return '禁用'
    return String(value)
  }

  const formatActivityEventTagText = (event: BackendUsageCode['activityEvents'][number]) => {
    if (!event.providerProfileName || event.credits == null) return null
    const isIncrease = event.eventType === 'admin_increase' || event.eventType === 'video_admin_increase' || event.eventType === 'refund' || event.eventType === 'video_refund'
    const isDecrease = event.eventType === 'admin_decrease' || event.eventType === 'video_admin_decrease' || event.eventType === 'reserve' || event.eventType === 'video_reserve'
    if (!isIncrease && !isDecrease) return null
    return `${event.providerProfileName}：${isIncrease ? '+' : '-'}${event.credits}`
  }

  const getEnabledProfilesForUsageCode = (allowedProviderProfileIds: string[] | null | undefined) => {
    if (!allowedProviderProfileIds?.length) return profiles
    return allowedProviderProfileIds
      .map((id) => profiles.find((profile) => profile.id === id))
      .filter((profile): profile is BackendProviderProfile => Boolean(profile))
  }

  const loadSettings = async () => {
    const [runtimeSettings, nextProfiles, nextProviderOptions, nextDistribution, nextUsageCodes] = await Promise.all([
      fetchBackendRuntimeSettings().catch(() => null),
      isAdmin ? fetchBackendProviderProfiles().catch(() => []) : Promise.resolve([]),
      fetchBackendProviderOptions().catch(() => []),
      isAdmin ? fetchBackendDistribution().catch(() => ({ enabled: false, maxConcurrentTasks: 2 })) : Promise.resolve({ enabled: false, maxConcurrentTasks: 2 }),
      isAdmin ? fetchBackendUsageCodes().catch(() => []) : Promise.resolve([]),
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
          }
        : {}),
    }

    setDraft(nextDraft)
    setSettings(nextDraft)
    const visibleProfiles = nextProfiles.length || !runtimeSettings
      ? nextProfiles
      : [{
          id: runtimeSettings.id ?? 'default',
          name: runtimeSettings.name ?? '默认节点',
          baseUrl: runtimeSettings.baseUrl,
          apiKey: '',
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
    setUsageCodes(nextUsageCodes)
    setExpandedUsageCodeIds((prev) => {
      const existing = new Set(prev)
      return nextUsageCodes
        .filter((code) => existing.has(code.id))
        .map((code) => code.id)
    })
    const defaultProfile = visibleProfiles.find((profile) => profile.isDefault) ?? visibleProfiles[0]
    if (defaultProfile) {
      setProfileDraft({ ...defaultProfile, apiKey: '' })
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

  useCloseOnEscape(showSettings, () => setShowSettings(false))

  if (!showSettings) return null

  const updateDraft = (patch: Partial<AppSettings>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  const updateProfileDraft = (patch: Partial<BackendProviderProfile>) => {
    setProfileDraft((prev) => ({ ...prev, ...patch }))
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
      baseUrl: normalizeBaseUrl(profileDraft.baseUrl.trim() || DEFAULT_SETTINGS.baseUrl),
      model: profileDraft.model.trim() || getDefaultModelForMode(profileDraft.apiMode),
      timeoutSeconds: Number(profileDraft.timeoutSeconds) || DEFAULT_SETTINGS.timeout,
      apiMode: profileDraft.apiMode === 'videos' ? 'videos' : profileDraft.apiMode === 'responses' ? 'responses' : 'images',
      codexCli: profileDraft.apiMode === 'videos' ? false : profileDraft.codexCli,
      grokApiCompat: profileDraft.grokApiCompat,
      xaiImage2kEnabled: profileDraft.apiMode === 'images' && profileDraft.grokApiCompat ? profileDraft.xaiImage2kEnabled : false,
      responseFormatB64Json: profileDraft.apiMode === 'videos' ? false : profileDraft.responseFormatB64Json,
      videoMaxResolution: profileDraft.apiMode === 'videos' && profileDraft.grokApiCompat ? profileDraft.videoMaxResolution ?? '480p' : '480p',
      videoMaxDuration: profileDraft.apiMode === 'videos' && profileDraft.grokApiCompat ? profileDraft.videoMaxDuration ?? 6 : 6,
      isDefault: true,
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

      const savedPreferences = await saveBackendRuntimePreferences({
        clearInputAfterSubmit: draft.clearInputAfterSubmit,
        persistInputOnRestart: draft.persistInputOnRestart,
        reuseTaskApiProfileTemporarily: draft.reuseTaskApiProfileTemporarily,
        alwaysShowRetryButton: draft.alwaysShowRetryButton,
      })

      const nextSettings: Partial<AppSettings> = {
        baseUrl: savedProfile.baseUrl,
        apiKey: '',
        apiKeyMasked: savedProfile.apiKeyMasked ?? null,
        apiKeyConfigured: savedProfile.apiKeyConfigured ?? true,
        providerProfileId: savedProfile.id,
        model: savedProfile.model,
        apiMode: savedProfile.apiMode,
        timeout: savedProfile.timeoutSeconds,
        codexCli: savedProfile.codexCli,
        grokApiCompat: savedProfile.grokApiCompat,
        xaiImage2kEnabled: savedProfile.xaiImage2kEnabled,
        responseFormatB64Json: savedProfile.responseFormatB64Json,
        videoMaxResolution: savedProfile.videoMaxResolution ?? '480p',
        videoMaxDuration: savedProfile.videoMaxDuration ?? 6,
        clearInputAfterSubmit: savedPreferences.clearInputAfterSubmit,
        persistInputOnRestart: savedPreferences.persistInputOnRestart,
        reuseTaskApiProfileTemporarily: savedPreferences.reuseTaskApiProfileTemporarily,
        alwaysShowRetryButton: savedPreferences.alwaysShowRetryButton,
      }

      setSettings(nextSettings)
      setDraft((prev) => ({ ...prev, ...nextSettings }))
      await loadSettings()
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

  const handleExportBackup = async () => {
    setIsExporting(true)
    try {
      await exportBackendBackup()
      useStore.getState().showToast('备份包已保存到本地', 'success')
    } catch (err) {
      useStore.getState().showToast(
        `导出备份失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsExporting(false)
    }
  }

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setIsImporting(true)
    try {
      const result = await importBackendBackup(file)
      await clearAllData({ silent: true })
      await refreshFromBackend()
      await loadSettings()
      useStore.getState().showToast(
        `导入完成：${result.importedTasks} 条任务，${result.importedImages} 张图片`,
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

  const handleResetRemoteData = async (mode: 'tasks' | 'all') => {
    setIsClearingRemote(true)
    try {
      await resetBackendRemoteData(mode)
      if (mode === 'all') {
        await clearAllData({ silent: true })
        setDraft(DEFAULT_SETTINGS)
        setProfileDraft(createEmptyProfile())
      } else {
        await clearLocalTaskCache({ silent: true })
        await refreshFromBackend()
      }
      useStore.getState().showToast(
        mode === 'all' ? '远端数据与设置已清空' : '远端任务与图片已清空',
        'success',
      )
    } catch (err) {
      useStore.getState().showToast(
        `清空远端存储失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
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
        allowedProviderProfileIds: newCodeAllowedProviderProfileIds,
        providerImageQuotas,
        providerVideoQuotas,
      })
      setLatestPlainCode(result.code)
      setUsageCodes((prev) => [result.item, ...prev.filter((item) => item.id !== result.item.id)])
      setNewCodeAllowedProviderProfileIds(null)
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
      <div className="glass-surface-strong relative z-10 flex h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-white/50 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:ring-white/10">
        <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">设置</h3>
          <div className="flex items-center gap-3">
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
          {isAdmin && <button className={tabClass('distribution')} onClick={() => setActiveTab('distribution')}>分发管理</button>}
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
                    label: (
                      <ProviderProfileTag
                        name={option.name}
                        colorKey={option.id}
                        tagColor={option.tagColor}
                        apiMode={option.apiMode}
                        isDefault={option.isDefault}
                      />
                    ),
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
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  任务列表会显示以上所有使用码对应的图片。
                </div>
              </div>
            </div>
          )}

          {activeTab === 'api' && isAdmin && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Select
                  value={selectedProfileId}
                  onChange={(value) => {
                    if (value === '__new__') {
                      setProfileDraft(createEmptyProfile())
                      return
                    }
                    const profile = profiles.find((item) => item.id === value)
                    if (profile) setProfileDraft({ ...profile, apiKey: '' })
                  }}
                  options={[
                    ...profiles.map((profile) => ({
                      label: (
                        <ProviderProfileTag
                          name={profile.name}
                          colorKey={profile.id}
                          tagColor={profile.tagColor}
                          apiMode={profile.apiMode}
                          isDefault={profile.isDefault}
                        />
                      ),
                      value: profile.id,
                    })),
                    { label: '新增 API 配置', value: '__new__' },
                  ]}
                  className="flex-1 rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
                <button
                  type="button"
                  onClick={() => setProfileDraft(createEmptyProfile())}
                  className="w-20 shrink-0 whitespace-nowrap rounded-xl bg-blue-50 px-3 py-2 text-sm font-medium leading-normal text-blue-500 transition hover:bg-blue-100 dark:bg-blue-500/10 dark:hover:bg-blue-500/20"
                >
                  新增
                </button>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">配置名称</span>
                <input
                  value={profileDraft.name}
                  onChange={(event) => updateProfileDraft({ name: event.target.value })}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">API URL</span>
                <input
                  value={profileDraft.baseUrl}
                  onChange={(event) => updateProfileDraft({ baseUrl: event.target.value })}
                  placeholder={DEFAULT_SETTINGS.baseUrl}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>

              <div>
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">API Key</span>
                <div className="relative">
                  <input
                    value={profileDraft.apiKey ?? ''}
                    onChange={(event) => updateProfileDraft({ apiKey: event.target.value })}
                    type={showApiKey ? 'text' : 'password'}
                    placeholder={profileDraft.apiKeyMasked ?? '输入后保存到后端'}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 pr-10 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((value) => !value)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 transition hover:text-gray-600 dark:hover:text-gray-200"
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
                <input
                  value={profileDraft.model}
                  onChange={(event) => updateProfileDraft({ model: event.target.value })}
                  placeholder={getDefaultModelForMode(profileDraft.apiMode)}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">请求超时 (秒)</span>
                <input
                  value={profileDraft.timeoutSeconds}
                  onChange={(event) => updateProfileDraft({ timeoutSeconds: Number(event.target.value) })}
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
                  {isSaving ? '保存中...' : '保存并设为默认'}
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
                  <input
                    value={distribution.maxConcurrentTasks}
                    onChange={(event) => setDistribution((prev) => ({
                      ...prev,
                      maxConcurrentTasks: Math.max(1, Number(event.target.value) || 1),
                    }))}
                    onBlur={handleSaveConcurrency}
                    type="number"
                    min={1}
                    max={50}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                  />
                </label>
              </div>

              <div className="rounded-2xl border border-gray-200/70 bg-gray-50/60 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_5rem]">
                  <input
                    value={newCodeName}
                    onChange={(event) => setNewCodeName(event.target.value)}
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
                  <div className="mt-3 rounded-xl bg-white px-3 py-2 text-sm dark:bg-black/20">
                    <span className="text-gray-500 dark:text-gray-400">新使用码：</span>
                    <span className="font-mono font-semibold tracking-wide text-gray-900 dark:text-gray-100">{latestPlainCode}</span>
                  </div>
                )}
                {profiles.length > 0 && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <span className="mb-2 block text-xs text-gray-500 dark:text-gray-400">允许调用的 API 配置</span>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setNewCodeAllowedProviderProfileIds(null)}
                          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                            !newCodeAllowedProviderProfileIds?.length
                              ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                              : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/[0.05] dark:text-gray-400 dark:hover:bg-white/[0.08]'
                          }`}
                        >
                          全部可用
                        </button>
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
                              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                                selected
                                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/[0.05] dark:text-gray-400 dark:hover:bg-white/[0.08]'
                              }`}
                            >
                              {profile.name}
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
                            <input
                              value={newCodeProviderImageQuotas[profile.id] ?? ''}
                              onChange={(event) => {
                                const value = event.target.value
                                const nextProviderImageQuotas = {
                                  ...newCodeProviderImageQuotas,
                                  [profile.id]: value,
                                }
                                setNewCodeProviderImageQuotas(nextProviderImageQuotas)
                              }}
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
                            <input
                              value={newCodeProviderVideoQuotas[profile.id] ?? ''}
                              onChange={(event) => {
                                setNewCodeProviderVideoQuotas((prev) => ({
                                  ...prev,
                                  [profile.id]: event.target.value,
                                }))
                              }}
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
                <input
                  value={usageCodeSearchQuery}
                  onChange={(event) => setUsageCodeSearchQuery(event.target.value)}
                  placeholder="搜索使用码或别名"
                  className="w-full rounded-xl border border-gray-200/70 bg-white/70 px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.03]"
                />
                {filteredUsageCodes.map((code) => {
                  const imageQuotaEditorProfiles = getQuotaEditorProfiles(code.allowedProviderProfileIds, 'image')
                  const videoQuotaEditorProfiles = getQuotaEditorProfiles(code.allowedProviderProfileIds, 'video')
                  const isExpanded = expandedUsageCodeIds.includes(code.id)
                  const enabledProfiles = getEnabledProfilesForUsageCode(code.allowedProviderProfileIds)
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
                              <input
                                value={code.name}
                                onChange={(event) => {
                                  const name = event.target.value
                                  setUsageCodes((prev) => prev.map((item) => item.id === code.id ? { ...item, name } : item))
                                }}
                                onBlur={() => handleUpdateUsageCode(code.id, { name: code.name.trim() || '未命名使用码' })}
                                className="w-full rounded-lg bg-transparent pr-2 text-sm font-medium text-gray-800 outline-none dark:text-gray-100"
                              />
                              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                任务 {code.taskCount} · 已生成图片 {code.outputImageCount} · 已生成视频 {code.outputVideoCount}
                              </p>
                              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                                最近使用：{code.lastUsedAt ? new Date(code.lastUsedAt).toLocaleString('zh-CN') : '从未使用'}
                              </p>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {enabledProfiles.length > 0 ? enabledProfiles.map((profile) => (
                                  <ProviderProfileTag
                                    key={profile.id}
                                    name={profile.name}
                                    colorKey={profile.id}
                                    tagColor={profile.tagColor}
                                    apiMode={profile.apiMode}
                                    isDefault={Boolean(profile.isDefault)}
                                    includeMode={false}
                                    includeDefault={false}
                                    className="max-w-[9rem]"
                                  />
                                )) : (
                                  <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500 dark:bg-white/[0.05] dark:text-gray-400">
                                    未启用 API
                                  </span>
                                )}
                              </div>
                            </div>
                            <Switch
                              checked={code.isEnabled}
                              onChange={(checked) => handleUpdateUsageCode(code.id, { isEnabled: checked })}
                            />
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="rounded-lg bg-gray-100 px-2 py-1 font-mono text-xs text-gray-800 dark:bg-black/20 dark:text-gray-100">
                              {code.code ?? '旧使用码无法恢复'}
                            </span>
                            {code.code && (
                              <button
                                type="button"
                                onClick={() => {
                                  void navigator.clipboard.writeText(code.code ?? '')
                                    .then(() => useStore.getState().showToast('使用码已复制', 'success'))
                                    .catch(() => useStore.getState().showToast('复制失败', 'error'))
                                }}
                                className="rounded-lg bg-blue-50 px-2 py-1 text-xs font-medium text-blue-600 transition hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20"
                              >
                                复制
                              </button>
                            )}
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
                              {profiles.length > 0 && (
                                <div className="mt-3">
                                  <span className="mb-2 block text-xs text-gray-500 dark:text-gray-400">允许调用的 API 配置</span>
                                  <div className="flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      onClick={() => void handleUpdateUsageCode(code.id, { allowedProviderProfileIds: null })}
                                      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                                        !code.allowedProviderProfileIds?.length
                                          ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                                          : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/[0.05] dark:text-gray-400 dark:hover:bg-white/[0.08]'
                                      }`}
                                    >
                                      全部可用
                                    </button>
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
                                          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                                            selected
                                              ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                                              : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-white/[0.05] dark:text-gray-400 dark:hover:bg-white/[0.08]'
                                          }`}
                                        >
                                          {profile.name}
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
                                          <input
                                            value={providerQuotaValue}
                                            onChange={(event) => setUsageCodeProviderImageQuotaDrafts((prev) => ({
                                              ...prev,
                                              [code.id]: {
                                                ...(prev[code.id] ?? {}),
                                                [profile.id]: event.target.value,
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
                                          <input
                                            value={providerQuotaValue}
                                            onChange={(event) => setUsageCodeProviderVideoQuotaDrafts((prev) => ({
                                              ...prev,
                                              [code.id]: {
                                                ...(prev[code.id] ?? {}),
                                                [profile.id]: event.target.value,
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
                              {code.activityEvents.length > 0 && (
                                <div className="mt-4">
                                  <span className="mb-2 block text-xs text-gray-500 dark:text-gray-400">行为记录</span>
                                  <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-gray-200/70 bg-white/40 p-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
                                    {code.activityEvents.map((event) => (
                                      <div key={event.id} className="rounded-lg bg-white/70 px-3 py-2 text-xs dark:bg-white/[0.04]">
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="min-w-0 flex-1 text-gray-800 dark:text-gray-100">{event.label}</div>
                                          {event.providerProfileName && (
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
                                    ))}
                                  </div>
                                </div>
                              )}
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
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={handleExportBackup}
                  disabled={isExporting || isImporting || isClearingRemote}
                  className="rounded-xl border border-gray-200/80 bg-gray-50/60 px-4 py-2.5 text-sm text-gray-700 transition hover:bg-gray-100/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                >
                  {isExporting ? '打包中...' : '打包保存到本地'}
                </button>
                <button
                  type="button"
                  onClick={() => importInputRef.current?.click()}
                  disabled={isImporting || isExporting || isClearingRemote}
                  className="rounded-xl border border-gray-200/80 bg-gray-50/60 px-4 py-2.5 text-sm text-gray-700 transition hover:bg-gray-100/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                >
                  {isImporting ? '导入中...' : '导入本地备份'}
                </button>
              </div>
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
                  disabled={isClearingRemote || isImporting || isExporting}
                  className="rounded-xl border border-orange-200/80 bg-orange-50/50 px-4 py-2.5 text-sm text-orange-600 transition hover:bg-orange-100/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-300 dark:hover:bg-orange-500/20"
                >
                  {isClearingRemote ? '清空中...' : '清空远端记录'}
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
                  disabled={isClearingRemote || isImporting || isExporting}
                  className="rounded-xl border border-red-200/80 bg-red-50/50 px-4 py-2.5 text-sm text-red-500 transition hover:bg-red-100/80 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
                >
                  {isClearingRemote ? '清空中...' : '清空远端全部'}
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
              <input
                ref={importInputRef}
                type="file"
                accept=".zip,application/zip"
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
    </div>
  )
}
