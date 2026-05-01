import { useEffect, useRef, useState } from 'react'
import { normalizeBaseUrl } from '../lib/devProxy'
import { fetchBackendRuntimeSettings, resetBackendRemoteData, saveBackendRuntimeSettings } from '../lib/backendSettings'
import { exportBackendBackup, importBackendBackup } from '../lib/backendBackup'
import { fetchBackendTasks } from '../lib/backendTasks'
import { useStore, clearAllData, clearLocalTaskCache } from '../store'
import { DEFAULT_IMAGES_MODEL, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, type AppSettings } from '../types'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import Select from './Select'

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [timeoutInput, setTimeoutInput] = useState(String(settings.timeout))
  const [showApiKey, setShowApiKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isClearingRemote, setIsClearingRemote] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const getDefaultModelForMode = (apiMode: AppSettings['apiMode']) =>
    apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL

  useEffect(() => {
    if (!showSettings) return

    setDraft(settings)
    setTimeoutInput(String(settings.timeout))

    void fetchBackendRuntimeSettings()
      .then((runtimeSettings) => {
        if (!runtimeSettings) return
        const nextDraft: AppSettings = {
          ...settings,
          baseUrl: runtimeSettings.baseUrl,
          apiKey: runtimeSettings.apiKey,
          apiKeyMasked: runtimeSettings.apiKeyMasked ?? null,
          apiKeyConfigured: runtimeSettings.apiKeyConfigured,
          model: runtimeSettings.model,
          apiMode: runtimeSettings.apiMode,
          timeout: runtimeSettings.timeoutSeconds,
          codexCli: runtimeSettings.codexCli,
        }
        setDraft(nextDraft)
        setTimeoutInput(String(runtimeSettings.timeoutSeconds))
      })
      .catch((err) => {
        useStore.getState().showToast(
          `读取后端设置失败：${err instanceof Error ? err.message : String(err)}`,
          'error',
        )
      })
  }, [showSettings, settings])

  useCloseOnEscape(showSettings, () => setShowSettings(false))

  if (!showSettings) return null

  const normalizedTimeout = (() => {
    const nextTimeout = Number(timeoutInput)
    if (timeoutInput.trim() === '' || Number.isNaN(nextTimeout)) {
      return DEFAULT_SETTINGS.timeout
    }
    return nextTimeout
  })()

  const handleSave = async () => {
    const normalizedDraft: AppSettings = {
      ...draft,
      baseUrl: normalizeBaseUrl(draft.baseUrl.trim() || DEFAULT_SETTINGS.baseUrl),
      model: draft.model.trim() || getDefaultModelForMode(draft.apiMode),
      timeout: normalizedTimeout,
      apiMode: draft.apiMode === 'responses' ? 'responses' : 'images',
      apiKey: draft.apiKey.trim(),
      apiKeyConfigured: Boolean(draft.apiKey.trim()),
    }

    if (!normalizedDraft.apiKey) {
      useStore.getState().showToast('请填写 API Key', 'error')
      return
    }

    setIsSaving(true)
    try {
      const saved = await saveBackendRuntimeSettings({
        baseUrl: normalizedDraft.baseUrl,
        apiKey: normalizedDraft.apiKey,
        model: normalizedDraft.model,
        apiMode: normalizedDraft.apiMode,
        timeoutSeconds: normalizedDraft.timeout,
        codexCli: normalizedDraft.codexCli,
      })

      const nextSettings: Partial<AppSettings> = {
        baseUrl: saved.baseUrl,
        apiKey: saved.apiKey,
        apiKeyMasked: saved.apiKeyMasked ?? null,
        apiKeyConfigured: saved.apiKeyConfigured,
        model: saved.model,
        apiMode: saved.apiMode,
        timeout: saved.timeoutSeconds,
        codexCli: saved.codexCli,
      }

      setSettings(nextSettings)
      setDraft((prev) => ({ ...prev, ...nextSettings }))
      useStore.getState().showToast('后端运行设置已保存', 'success')
      setShowSettings(false)
    } catch (err) {
      useStore.getState().showToast(
        `保存后端设置失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setIsSaving(false)
    }
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
      }
      setSettings(nextSettings)
      setDraft((prev) => ({ ...prev, ...nextSettings }))
      setTimeoutInput(String(runtimeSettings.timeoutSeconds))
    }

    useStore.getState().setTasks(tasks)
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
        setTimeoutInput(String(DEFAULT_SETTINGS.timeout))
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

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="glass-overlay-soft absolute inset-0 animate-overlay-in"
        onClick={() => setShowSettings(false)}
      />
      <div className="glass-surface-strong relative z-10 w-full max-w-md rounded-3xl border border-white/50 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:ring-white/10 overflow-y-auto max-h-[85vh] custom-scrollbar">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">设置</h3>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 dark:text-gray-500 font-mono select-none">v{__APP_VERSION__}</span>
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

        <div className="space-y-6">
          <section>
            <div className="mb-4 flex items-center justify-between">
              <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">后端运行配置</h4>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">API URL</span>
                <input
                  value={draft.baseUrl}
                  onChange={(e) => setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
                  type="text"
                  placeholder={DEFAULT_SETTINGS.baseUrl}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>

              <div className="block">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-gray-500 dark:text-gray-400">API Key</span>
                </div>
                <div className="relative">
                  <input
                    value={draft.apiKey}
                    onChange={(e) => setDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
                    type={showApiKey ? 'text' : 'password'}
                    placeholder={draft.apiKeyMasked ?? '输入后保存到后端'}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 pr-10 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((v) => !v)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 transition hover:text-gray-600 dark:hover:text-gray-200"
                    title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                    aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                  >
                    {showApiKey ? (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18M10.584 10.587a2 2 0 102.829 2.829M9.88 4.24A9.956 9.956 0 0112 4c5.523 0 10 4 10 8 0 1.354-.512 2.629-1.414 3.742M6.228 6.228C3.608 7.8 2 9.777 2 12c0 4 4.477 8 10 8 2.09 0 4.03-.572 5.648-1.55" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.269 2.943 9.542 7-1.273 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">API 接口</span>
                <Select
                  value={draft.apiMode}
                  onChange={(value) => {
                    const apiMode = value as AppSettings['apiMode']
                    const nextModel =
                      draft.model === DEFAULT_IMAGES_MODEL || draft.model === DEFAULT_RESPONSES_MODEL
                        ? getDefaultModelForMode(apiMode)
                        : draft.model
                    setDraft((prev) => ({ ...prev, apiMode, model: nextModel }))
                  }}
                  options={[
                    { label: 'Images API (/v1/images)', value: 'images' },
                    { label: 'Responses API (/v1/responses)', value: 'responses' },
                  ]}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">模型 ID</span>
                <input
                  value={draft.model}
                  onChange={(e) => setDraft((prev) => ({ ...prev, model: e.target.value }))}
                  type="text"
                  placeholder={getDefaultModelForMode(draft.apiMode)}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">请求超时 (秒)</span>
                <input
                  value={timeoutInput}
                  onChange={(e) => setTimeoutInput(e.target.value)}
                  type="number"
                  min={10}
                  max={1800}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>

              <label className="flex items-center justify-between rounded-2xl border border-gray-200/70 bg-gray-50/70 px-3 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div>
                  <div className="text-sm text-gray-700 dark:text-gray-200">Codex CLI 模式</div>
                  <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">保存后由后端作为默认运行模式使用</div>
                </div>
                <button
                  type="button"
                  onClick={() => setDraft((prev) => ({ ...prev, codexCli: !prev.codexCli }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${draft.codexCli ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                >
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${draft.codexCli ? 'translate-x-5' : 'translate-x-1'}`} />
                </button>
              </label>
            </div>
          </section>

          <section className="pt-6 border-t border-gray-100 dark:border-white/[0.08]">
            <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200">数据管理</h4>
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
                      message: '这会删除后端数据库中的全部任务记录，以及后端媒体目录中的输入图、遮罩图、输出图和缩略图。\n\n当前浏览器刷新后不再恢复这些任务，但后端运行配置会保留。',
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
                      message: '这会删除后端任务记录、全部图片文件，以及后端保存的 API URL、API Key、模型、接口模式等运行配置。\n\n执行后刷新页面不会恢复，除非你重新填写设置或通过环境变量重新注入。',
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
          </section>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="flex-1 rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
