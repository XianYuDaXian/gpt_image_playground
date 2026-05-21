import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'
import { applyThemeMode } from './lib/theme'

installMobileViewportGuards()

try {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const iosMatch = userAgent.match(/OS (\d+)_\d+(?:_\d+)?/)
  const iosMajorVersion = iosMatch ? Number(iosMatch[1]) : null
  const shouldForceBackdropFallback = Number.isFinite(iosMajorVersion) && iosMajorVersion != null && iosMajorVersion <= 16
  const supportsBackdropFilter =
    typeof window !== 'undefined'
    && typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function'
    && !shouldForceBackdropFallback
    && (
      CSS.supports('backdrop-filter: blur(24px)')
      || CSS.supports('-webkit-backdrop-filter: blur(24px)')
    )
  document.documentElement.classList.toggle('supports-backdrop-filter', supportsBackdropFilter)
  document.documentElement.classList.toggle('no-backdrop-filter', !supportsBackdropFilter)
  document.documentElement.classList.toggle('legacy-backdrop-fallback', Boolean(shouldForceBackdropFallback))
} catch {
  document.documentElement.classList.add('no-backdrop-filter')
}

try {
  const saved = localStorage.getItem('gpt-image-playground')
  const parsed = saved ? JSON.parse(saved) as { state?: { themeMode?: 'system' | 'light' | 'dark' } } : null
  applyThemeMode(parsed?.state?.themeMode ?? 'system')
} catch {
  applyThemeMode('system')
}

const SW_CACHE_PREFIX = 'gpt-image-playground'

async function clearLegacyServiceWorkerCaches() {
  if (!('caches' in window)) return
  const keys = await caches.keys()
  await Promise.all(
    keys
      .filter((key) => key.startsWith(SW_CACHE_PREFIX) && key !== `${SW_CACHE_PREFIX}-${__APP_VERSION__}`)
      .map((key) => caches.delete(key)),
  )
}

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      let refreshing = false

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return
        refreshing = true
        window.location.reload()
      })

      clearLegacyServiceWorkerCaches().catch(() => {
        /* 忽略旧缓存清理失败 */
      })

      navigator.serviceWorker
        .register(`${import.meta.env.BASE_URL}sw.js?v=${__APP_VERSION__}`)
        .then((registration) => {
          const activateWaitingWorker = (worker: ServiceWorker | null) => {
            worker?.postMessage({ type: 'SKIP_WAITING' })
          }

          activateWaitingWorker(registration.waiting)

          registration.addEventListener('updatefound', () => {
            const worker = registration.installing
            if (!worker) return
            worker.addEventListener('statechange', () => {
              if (worker.state === 'installed') {
                activateWaitingWorker(registration.waiting ?? worker)
              }
            })
          })
        })
        .catch((error) => {
          console.error('Service worker registration failed:', error)
        })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
    clearLegacyServiceWorkerCaches().catch(() => {
      /* 忽略开发态缓存清理失败 */
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
