import { useEffect, useState } from 'react'
import { logout, useStore } from '../store'
import { cycleThemeMode, getThemeModeLabel } from '../lib/theme'
import { useVersionCheck } from '../hooks/useVersionCheck'
import { fetchAdminBackendReminders } from '../lib/backendSettings'
import { hasUnreadCompletedReminders, REMINDER_COMPLETED_STATE_CHANGED_EVENT } from '../lib/announcement'
import HelpModal from './HelpModal'

export default function Header() {
  const setShowSettings = useStore((s) => s.setShowSettings)
  const showSettings = useStore((s) => s.showSettings)
  const themeMode = useStore((s) => s.themeMode)
  const setThemeMode = useStore((s) => s.setThemeMode)
  const authStatus = useStore((s) => s.authStatus)
  const [showHelp, setShowHelp] = useState(false)
  const [hasUnreadReminderDot, setHasUnreadReminderDot] = useState(false)
  const [adminReminders, setAdminReminders] = useState<Awaited<ReturnType<typeof fetchAdminBackendReminders>>>([])
  const { hasUpdate, latestRelease, dismiss } = useVersionCheck()

  useEffect(() => {
    if (authStatus?.role !== 'admin') {
      setAdminReminders([])
      setHasUnreadReminderDot(false)
      return
    }

    let cancelled = false
    void fetchAdminBackendReminders()
      .then((items) => {
        if (cancelled) return
        setAdminReminders(items)
        setHasUnreadReminderDot(hasUnreadCompletedReminders(items))
      })
      .catch(() => {
        if (cancelled) return
        setAdminReminders([])
        setHasUnreadReminderDot(false)
      })

    return () => {
      cancelled = true
    }
  }, [authStatus?.role, showSettings])

  useEffect(() => {
    if (authStatus?.role !== 'admin' || !adminReminders.length) return
    setHasUnreadReminderDot(hasUnreadCompletedReminders(adminReminders))
    const timer = window.setInterval(() => {
      setHasUnreadReminderDot(hasUnreadCompletedReminders(adminReminders))
    }, 60 * 1000)
    const handleCompletedStateChanged = () => {
      setHasUnreadReminderDot(hasUnreadCompletedReminders(adminReminders))
    }
    window.addEventListener(REMINDER_COMPLETED_STATE_CHANGED_EVENT, handleCompletedStateChanged)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener(REMINDER_COMPLETED_STATE_CHANGED_EVENT, handleCompletedStateChanged)
    }
  }, [authStatus?.role, adminReminders])

  const openSettings = () => {
    setShowSettings(true)
  }

  return (
    <header className="safe-area-top glass-surface sticky top-0 z-40 border-b border-gray-200 dark:border-white/[0.08]">
      <div className="safe-area-x safe-header-inner max-w-7xl mx-auto flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1">
          <h1 className="min-w-0 truncate text-lg font-bold tracking-tight">
            <a
              href="https://github.com/XianYuDaXian/gpt_image_playground"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-800 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              GPT Image Playground
            </a>
          </h1>
          {hasUpdate && latestRelease ? (
            <a
              href={latestRelease.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={dismiss}
              className="mt-0.5 inline-flex items-center rounded-md bg-red-500 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white shadow-sm transition-opacity hover:opacity-90"
              title={`发现新版本 ${latestRelease.tag}`}
            >
              NEW
            </a>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {authStatus?.role === 'user' && (
            <button
              type="button"
              onClick={openSettings}
              className="inline-flex max-w-[5.5rem] shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.12]"
            >
              {authStatus.user?.remainingImageCredits == null
                ? '额度不限'
                : `剩余 ${authStatus.user.remainingImageCredits}`}
            </button>
          )}
          <button
            onClick={() => setThemeMode(cycleThemeMode(themeMode))}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            title={`主题：${getThemeModeLabel(themeMode)}`}
          >
            {themeMode === 'system' ? (
              <svg
                className="w-5 h-5 text-gray-600 dark:text-gray-400"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
              >
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path d="M8 20h8M12 16v4" />
              </svg>
            ) : themeMode === 'dark' ? (
              <svg
                className="w-5 h-5 text-gray-600 dark:text-gray-400"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
              >
                <path d="M21 12.79A9 9 0 1111.21 3c0 .31 0 .61.02.91A7 7 0 0021 12.79z" />
              </svg>
            ) : (
              <svg
                className="w-5 h-5 text-gray-600 dark:text-gray-400"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                viewBox="0 0 24 24"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            )}
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            title="操作指南"
          >
            <svg
              className="w-5 h-5 text-gray-600 dark:text-gray-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <path d="M12 17h.01" />
            </svg>
          </button>
          <button
            onClick={openSettings}
            className="relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            title="设置"
          >
            {authStatus?.role === 'admin' && hasUnreadReminderDot && (
              <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-gray-900" />
            )}
            <svg
              className="w-5 h-5 text-gray-600 dark:text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
          <button
            onClick={() => {
              void logout()
            }}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            title="退出登录"
          >
            <svg
              className="w-5 h-5 text-gray-600 dark:text-gray-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
          </button>
        </div>
      </div>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </header>
  )
}
