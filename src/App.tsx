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

export default function App() {
  const themeMode = useStore((s) => s.themeMode)

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
