import { useCallback, useEffect, useRef, useState } from 'react'
import { clearAllData, clearLocalTaskCache, initStore, refreshAuthStatus, refreshTasksFromServer } from './store'
import { useStore } from './store'
import type { MaintenanceStatus } from './lib/backendAuth'
import { downloadUsageCodeMediaExportFile, fetchUsageCodeMediaExportFiles } from './lib/backendBackup'
import { applyThemeMode, watchSystemTheme } from './lib/theme'
import { fetchAdminBackendReminders, fetchBackendReminders, type BackendReminderItem } from './lib/backendSettings'
import { getRemindersToShow, markRemindersShown } from './lib/announcement'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import LoginPage from './components/LoginPage'
import AnnouncementModal from './components/AnnouncementModal'
import AnnouncementListModal from './components/AnnouncementListModal'
import { preloadAnnouncementImages } from './lib/announcementImageCache'

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let current = value
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024
    index += 1
  }
  return `${current >= 100 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`
}

function getMaintenanceTitle(isAdmin: boolean, operation: MaintenanceStatus['operation'], phase: string) {
  if (!isAdmin && operation !== 'usage_code_media_export') return '管理员正在维护服务器'
  if (operation === 'backup_import') return phase === 'failed' ? '服务器恢复失败' : phase === 'completed' ? '服务器恢复已完成' : '服务器恢复进行中'
  if (operation === 'backup_export') return phase === 'failed' ? '服务器备份失败' : phase === 'completed' ? '服务器备份已完成' : '服务器备份进行中'
  if (operation === 'usage_code_media_export') return phase === 'failed' ? '导出失败' : phase === 'completed' ? '导出已完成' : '导出进行中'
  if (operation === 'remote_reset_usage_code') return phase === 'failed' ? '使用码任务清理失败' : phase === 'completed' ? '使用码任务清理已完成' : '正在清理使用码任务'
  if (operation === 'remote_reset_all') return phase === 'failed' ? '远端全部清空失败' : phase === 'completed' ? '远端全部已清空' : '正在清空远端全部'
  if (operation === 'remote_reset_tasks') return phase === 'failed' ? '远端记录清空失败' : phase === 'completed' ? '远端记录已清空' : '正在清空远端记录'
  return '服务器维护进行中'
}

function getMaintenanceStage(operation: MaintenanceStatus['operation'], phase: string) {
  if (operation === 'usage_code_media_export') return phase === 'preparing' ? '正在整理导出文件' : '正在生成导出文件'
  if (phase === 'preparing') return '等待队列完成'
  if (operation === 'backup_import') return '正在恢复备份'
  if (operation === 'backup_export') return '正在生成备份包'
  if (operation === 'remote_reset_usage_code') return '正在清理使用码任务'
  if (operation === 'remote_reset_all') return '正在清空远端全部'
  if (operation === 'remote_reset_tasks') return '正在清空远端记录'
  return '正在处理中'
}

const USAGE_CODE_EXPORT_NOTICE_SEEN_KEY = 'gpt-image-playground-usage-code-export-notice-seen'

function getSeenUsageCodeExportNoticeFinishedAt() {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(USAGE_CODE_EXPORT_NOTICE_SEEN_KEY) ?? ''
}

function markUsageCodeExportNoticeSeen(finishedAt: string) {
  if (typeof window === 'undefined' || !finishedAt) return
  window.localStorage.setItem(USAGE_CODE_EXPORT_NOTICE_SEEN_KEY, finishedAt)
}

function MaintenanceOverlay() {
  const authStatus = useStore((s) => s.authStatus)
  const maintenance = authStatus?.maintenance
  if (!maintenance?.active) return null
  if (maintenance.operation === 'usage_code_media_export') return null

  const isAdmin = authStatus?.role === 'admin'
  const isImport = maintenance.operation === 'backup_import'
  const isReset = maintenance.operation?.startsWith('remote_reset_')
  const detailText = maintenance.phase === 'preparing'
    ? `当前仍有执行中 ${maintenance.waitingRunningTasks} 个，排队中 ${maintenance.waitingPendingTasks} 个。`
    : isReset
      ? `已处理 ${maintenance.processedFiles}/${maintenance.totalFiles} 个步骤，${formatBytes(maintenance.processedBytes)}/${formatBytes(maintenance.totalBytes)}。`
      : `已处理 ${maintenance.processedFiles}/${maintenance.totalFiles} 个文件，${formatBytes(maintenance.processedBytes)}/${formatBytes(maintenance.totalBytes)}。`

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-3xl border border-white/15 bg-gray-950/95 p-6 text-white shadow-2xl">
        <div className="text-lg font-semibold">
          {getMaintenanceTitle(isAdmin, maintenance.operation, maintenance.phase)}
        </div>
        <p className="mt-2 text-sm leading-6 text-gray-300">
          {isAdmin ? '写入操作已暂停。维护结束后会自动恢复。' : '请稍等几分钟后再试。'}
        </p>
        {isAdmin && (
          <p className="mt-2 text-sm leading-6 text-gray-400">{maintenance.message || '正在处理中'}</p>
        )}
        <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
            style={{ width: `${isAdmin ? Math.max(4, maintenance.progressPercent) : 100}%` }}
          />
        </div>
        {isAdmin && (
          <>
            <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
              <span>{getMaintenanceStage(maintenance.operation, maintenance.phase)}</span>
              <span>{maintenance.progressPercent}%</span>
            </div>
            <div className="mt-3 text-xs leading-5 text-gray-400">{detailText}</div>
          </>
        )}
        {isAdmin && maintenance.error && (
          <div className="mt-3 break-all rounded-2xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
            {maintenance.error}
          </div>
        )}
        {isAdmin && maintenance.filePath && !maintenance.active && (
          <div className="mt-3 break-all rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs leading-5 text-gray-300">
            {maintenance.filePath}
          </div>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const themeMode = useStore((s) => s.themeMode)
  const authStatus = useStore((s) => s.authStatus)
  const authInitialized = useStore((s) => s.authInitialized)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [announcementQueue, setAnnouncementQueue] = useState<BackendReminderItem[]>([])
  const [showAnnouncementList, setShowAnnouncementList] = useState(false)
  const [announcementListItems, setAnnouncementListItems] = useState<BackendReminderItem[]>([])
  const [announcementListLoading, setAnnouncementListLoading] = useState(false)
  const [announcementListError, setAnnouncementListError] = useState<string | null>(null)
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<BackendReminderItem | null>(null)
  const announcement = announcementQueue[0] ?? null
  const maintenance = authStatus?.maintenance
  const previousMaintenanceRef = useRef(authStatus?.maintenance ?? null)
  const usageCodeExportNoticePendingRef = useRef<string>('')
  const hasOverlayOpen = useStore((s) =>
    Boolean(
      s.detailTaskId
      || s.lightboxImageId
      || s.maskEditorImageId
      || s.showSettings
      || s.confirmDialog
      || announcement
      || showAnnouncementList
      || selectedAnnouncement,
    ),
  )

  const loadRecentAnnouncements = useCallback(() => {
    if (!authStatus?.authenticated) return
    setAnnouncementListLoading(true)
    setAnnouncementListError(null)
    const request = authStatus.role === 'admin' ? fetchAdminBackendReminders() : fetchBackendReminders()
    void request
      .then((items) => {
        setAnnouncementListItems(items)
        preloadAnnouncementImages(items.flatMap((item) => item.imageDataUrls?.length ? item.imageDataUrls : item.imageDataUrl ? [item.imageDataUrl] : []))
      })
      .catch((err) => {
        setAnnouncementListItems([])
        setAnnouncementListError(`读取公告失败：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        setAnnouncementListLoading(false)
      })
  }, [authStatus?.authenticated, authStatus?.role])

  const openAnnouncementList = useCallback(() => {
    setShowAnnouncementList(true)
    loadRecentAnnouncements()
  }, [loadRecentAnnouncements])

  useEffect(() => {
    void (async () => {
      await initStore()
    })()
  }, [])

  useEffect(() => {
    const refresh = () => {
      void refreshAuthStatus({ silent: true })
    }
    refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 3000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  useEffect(() => {
    if (authStatus?.authenticated) return
    setShowAnnouncementList(false)
    setSelectedAnnouncement(null)
    setAnnouncementListItems([])
  }, [authStatus?.authenticated])

  useEffect(() => {
    applyThemeMode(themeMode)
    if (themeMode !== 'system') return
    return watchSystemTheme(() => applyThemeMode('system'))
  }, [themeMode])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  useEffect(() => {
    const html = document.documentElement
    const body = document.body

    if (hasOverlayOpen) {
      html.dataset.appScrollLock = '1'
      body.dataset.appScrollLock = '1'
      html.style.overflow = 'hidden'
      body.style.overflow = 'hidden'
      return
    }

    if (html.dataset.appScrollLock === '1') {
      delete html.dataset.appScrollLock
      html.style.overflow = ''
    }
    if (body.dataset.appScrollLock === '1') {
      delete body.dataset.appScrollLock
      body.style.overflow = ''
    }
  }, [hasOverlayOpen])

  useEffect(() => {
    const previous = previousMaintenanceRef.current
    previousMaintenanceRef.current = maintenance ?? null
    if (!maintenance || !previous) return
    if (previous.active && !maintenance.active && maintenance.phase === 'completed') {
      if (maintenance.operation === 'remote_reset_all') {
        void clearAllData({ silent: true })
      } else if (maintenance.operation === 'remote_reset_tasks' || maintenance.operation === 'remote_reset_usage_code') {
        void clearLocalTaskCache({ silent: true }).then(() => refreshTasksFromServer({ silent: true }))
      }
      const showToast = useStore.getState().showToast
      if (maintenance.operation === 'remote_reset_usage_code') {
        showToast('使用码任务与产物已清理完成', 'success')
      } else if (maintenance.operation === 'remote_reset_tasks') {
        showToast('远端记录已清空', 'success')
      } else if (maintenance.operation === 'remote_reset_all') {
        showToast('远端全部数据已清空', 'success')
      }
    }
    if (previous.active && !maintenance.active && maintenance.phase === 'failed' && maintenance.error) {
      useStore.getState().showToast(maintenance.error, 'error')
    }
  }, [maintenance])

  useEffect(() => {
    if (!authStatus?.authenticated || authStatus.role !== 'user') return
    if (maintenance?.operation !== 'usage_code_media_export') return
    if (maintenance.phase !== 'completed' || !maintenance.finishedAt) return
    if (usageCodeExportNoticePendingRef.current === maintenance.finishedAt) return
    if (getSeenUsageCodeExportNoticeFinishedAt() === maintenance.finishedAt) return

    usageCodeExportNoticePendingRef.current = maintenance.finishedAt

    void fetchUsageCodeMediaExportFiles()
      .then((result) => {
        const files = result.items
        if (!files.length) {
          markUsageCodeExportNoticeSeen(maintenance.finishedAt ?? '')
          return
        }

        markUsageCodeExportNoticeSeen(maintenance.finishedAt ?? '')
        const singleFile = files.length === 1 ? files[0] : null
        setConfirmDialog({
          title: '导出文件已生成',
          message: singleFile
            ? `导出文件 ${singleFile.fileName} 已生成。\n\n点击“立即下载”开始保存。`
            : `导出文件已生成，共 ${files.length} 个文件。\n\n点击“打开下载列表”查看并下载全部分包。`,
          confirmText: singleFile ? '立即下载' : '打开下载列表',
          action: () => {
            if (singleFile) {
              void downloadUsageCodeMediaExportFile(singleFile.fileName).catch((error) => {
                useStore.getState().showToast(
                  `下载导出文件失败：${error instanceof Error ? error.message : String(error)}`,
                  'error',
                )
              })
              return
            }
            setShowSettings(true)
          },
        })
      })
      .catch(() => {
        usageCodeExportNoticePendingRef.current = ''
      })
  }, [authStatus?.authenticated, authStatus?.role, maintenance, setConfirmDialog, setShowSettings])

  useEffect(() => {
    if (!authStatus?.authenticated || authStatus.role !== 'user') {
      setAnnouncementQueue([])
      return
    }

    let cancelled = false
    const checkReminders = () => {
      if (announcementQueue.length) return
      void fetchBackendReminders()
        .then((items) => {
          if (cancelled) return
          preloadAnnouncementImages(items.flatMap((item) => item.imageDataUrls?.length ? item.imageDataUrls : item.imageDataUrl ? [item.imageDataUrl] : []))
          const nextAnnouncements = getRemindersToShow(items)
          if (!nextAnnouncements.length) {
            setAnnouncementQueue([])
            return
          }
          markRemindersShown(nextAnnouncements)
          setAnnouncementQueue(nextAnnouncements)
        })
        .catch(() => {
          if (cancelled) return
          setAnnouncementQueue([])
        })
    }

    checkReminders()
    const timer = window.setInterval(checkReminders, 60 * 1000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [authStatus?.authenticated, authStatus?.role, authStatus?.usageCodes, announcementQueue.length])

  if (!authInitialized) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50 text-sm text-gray-500 dark:bg-gray-950 dark:text-gray-400">
        正在读取登录状态...
      </main>
    )
  }

  if (!authStatus?.authenticated) {
    return (
      <>
        <LoginPage />
        <Toast />
      </>
    )
  }

  return (
    <>
      <Header onOpenAnnouncements={openAnnouncementList} />
      <main data-home-main className="safe-area-x safe-main-bottom max-w-7xl mx-auto">
        <SearchBar />
        <TaskGrid />
      </main>
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      {showAnnouncementList && (
        <AnnouncementListModal
          items={announcementListItems}
          loading={announcementListLoading}
          error={announcementListError}
          onRefresh={loadRecentAnnouncements}
          onSelect={setSelectedAnnouncement}
          onClose={() => setShowAnnouncementList(false)}
        />
      )}
      {selectedAnnouncement && (
        <AnnouncementModal
          announcement={selectedAnnouncement}
          onClose={() => setSelectedAnnouncement(null)}
        />
      )}
      {announcement && !selectedAnnouncement && (
        <AnnouncementModal
          announcement={announcement}
          onClose={() => setAnnouncementQueue((prev) => prev.slice(1))}
        />
      )}
      <MaintenanceOverlay />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
