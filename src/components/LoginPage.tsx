import { useEffect, useState } from 'react'
import { initStore, useStore } from '../store'
import { loginAdmin, loginWithCode } from '../lib/backendAuth'
import { cycleThemeMode, getThemeModeLabel } from '../lib/theme'

type LoginMode = 'code' | 'admin'

export default function LoginPage() {
  const authStatus = useStore((s) => s.authStatus)
  const setAuthStatus = useStore((s) => s.setAuthStatus)
  const showToast = useStore((s) => s.showToast)
  const themeMode = useStore((s) => s.themeMode)
  const setThemeMode = useStore((s) => s.setThemeMode)
  const [mode, setMode] = useState<LoginMode>(authStatus?.distributionEnabled ? 'code' : 'admin')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const canUseCode = Boolean(authStatus?.distributionEnabled)

  useEffect(() => {
    if (!canUseCode && mode === 'code') {
      setMode('admin')
    }
  }, [canUseCode, mode])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setIsSubmitting(true)
    try {
      const nextStatus = mode === 'admin'
        ? await loginAdmin(password)
        : await loginWithCode(code)
      setAuthStatus(nextStatus)
      await initStore()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="safe-area-x relative flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10 dark:bg-gray-950">
      <button
        type="button"
        onClick={() => setThemeMode(cycleThemeMode(themeMode))}
        className="absolute right-5 top-5 rounded-xl border border-gray-200 bg-white/80 p-2 text-gray-600 shadow-sm transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
        title={`主题：${getThemeModeLabel(themeMode)}`}
        aria-label={`主题：${getThemeModeLabel(themeMode)}`}
      >
        {themeMode === 'dark' ? (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M21 12.79A9 9 0 1111.21 3c0 .31 0 .61.02.91A7 7 0 0021 12.79z" />
          </svg>
        ) : themeMode === 'light' ? (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
        ) : (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
          </svg>
        )}
      </button>
      <section className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-white/[0.08] dark:bg-gray-900">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">GPT Image Playground</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {mode === 'admin' ? '输入管理员密码后继续。' : '输入管理员分配的使用码后继续。'}
          </p>
        </div>

        <div className="mb-4 grid grid-cols-2 rounded-xl bg-gray-100 p-1 dark:bg-white/[0.06]">
          <button
            type="button"
            onClick={() => canUseCode && setMode('code')}
            disabled={!canUseCode}
            className={`rounded-lg px-3 py-2 text-sm transition ${
              mode === 'code'
                ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800 dark:text-blue-300'
                : 'text-gray-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400'
            }`}
          >
            使用码
          </button>
          <button
            type="button"
            onClick={() => setMode('admin')}
            className={`rounded-lg px-3 py-2 text-sm transition ${
              mode === 'admin'
                ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800 dark:text-blue-300'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            管理员
          </button>
        </div>

        {!authStatus?.adminConfigured && (
          <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-700 dark:border-orange-400/20 dark:bg-orange-500/10 dark:text-orange-300">
            服务端未配置 ADMIN_PASSWORD。
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'admin' ? (
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">管理员密码</span>
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete="current-password"
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100"
              />
            </label>
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">使用码</span>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm uppercase tracking-wide text-gray-800 outline-none focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100"
              />
            </label>
          )}
          <button
            type="submit"
            disabled={isSubmitting || (mode === 'admin' ? !password.trim() : !code.trim())}
            className="w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? '登录中...' : '登录'}
          </button>
        </form>
      </section>
    </main>
  )
}
