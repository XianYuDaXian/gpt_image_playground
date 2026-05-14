import { useEffect, useState } from 'react'

const KEYBOARD_THRESHOLD = 0.75

export function useKeyboardVisible() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let fromViewport = false
    let fromFocus = false
    let baseHeight = window.visualViewport?.height || window.innerHeight
    let focusOutTimer: ReturnType<typeof setTimeout> | null = null
    const update = () => setVisible(fromViewport || fromFocus)
    const refreshBaseHeight = (currentHeight: number) => {
      if (!fromFocus && currentHeight > baseHeight) {
        baseHeight = currentHeight
      }
    }

    const vv = window.visualViewport
    const onViewportResize = () => {
      if (!vv) return
      refreshBaseHeight(vv.height)
      fromViewport = vv.height < baseHeight * KEYBOARD_THRESHOLD
      update()
    }

    const onWindowResize = () => {
      const currentHeight = window.innerHeight
      refreshBaseHeight(currentHeight)
      if (currentHeight > baseHeight * 0.85) {
        fromFocus = false
        update()
      } else if (currentHeight < baseHeight * KEYBOARD_THRESHOLD) {
        fromFocus = true
        update()
      }
    }

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        fromFocus = true
        update()
      }
    }

    const onFocusOut = (event: FocusEvent) => {
      const related = event.relatedTarget as HTMLElement | null
      if (related && (related.isContentEditable || related.tagName === 'INPUT' || related.tagName === 'TEXTAREA')) {
        return
      }
      fromFocus = false
      focusOutTimer = setTimeout(() => {
        const currentHeight = window.visualViewport?.height || window.innerHeight
        if (currentHeight > baseHeight * 0.85) {
          fromViewport = false
        }
        update()
      }, 100)
    }

    if (vv) vv.addEventListener('resize', onViewportResize)
    window.addEventListener('resize', onWindowResize)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)

    return () => {
      if (vv) vv.removeEventListener('resize', onViewportResize)
      window.removeEventListener('resize', onWindowResize)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      if (focusOutTimer) clearTimeout(focusOutTimer)
    }
  }, [])

  return visible
}
