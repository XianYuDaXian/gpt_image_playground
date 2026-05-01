import type { ThemeMode } from '../types'

export function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyThemeMode(mode: ThemeMode) {
  if (typeof document === 'undefined') return
  const resolved = resolveThemeMode(mode)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
}

export function watchSystemTheme(onChange: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }

  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => onChange()
  media.addEventListener('change', handler)
  return () => media.removeEventListener('change', handler)
}

export function cycleThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === 'system') return 'dark'
  if (mode === 'dark') return 'light'
  return 'system'
}

export function getThemeModeLabel(mode: ThemeMode) {
  if (mode === 'dark') return '深色模式'
  if (mode === 'light') return '浅色模式'
  return '跟随系统'
}
