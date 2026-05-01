import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'
import { applyThemeMode } from './lib/theme'

installMobileViewportGuards()

try {
  const saved = localStorage.getItem('gpt-image-playground')
  const parsed = saved ? JSON.parse(saved) as { state?: { themeMode?: 'system' | 'light' | 'dark' } } : null
  applyThemeMode(parsed?.state?.themeMode ?? 'system')
} catch {
  applyThemeMode('system')
}

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
        console.error('Service worker registration failed:', error)
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
