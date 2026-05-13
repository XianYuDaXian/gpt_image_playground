import { useEffect } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { applyThemeMode, watchSystemTheme } from './lib/theme'
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

export default function App() {
  const themeMode = useStore((s) => s.themeMode)
  const authStatus = useStore((s) => s.authStatus)
  const authInitialized = useStore((s) => s.authInitialized)
  const hasOverlayOpen = useStore((s) =>
    Boolean(s.detailTaskId || s.lightboxImageId || s.maskEditorImageId || s.showSettings || s.confirmDialog),
  )

  useEffect(() => {
    void (async () => {
      await initStore()
    })()
  }, [])

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
      <Header />
      <main data-home-main className="safe-area-x safe-main-bottom max-w-7xl mx-auto">
        <SearchBar />
        <TaskGrid />
      </main>
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
