import { useCallback, useEffect, useRef, useState } from 'react'

interface UseHintTooltipOptions {
  enabled?: () => boolean
  autoHideMs?: number
  touchDelayMs?: number
}

export function useHintTooltip(options: UseHintTooltipOptions = {}) {
  const { autoHideMs, touchDelayMs = 450 } = options
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<number | null>(null)
  const enabledRef = useRef(options.enabled)
  enabledRef.current = options.enabled

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const hide = useCallback(() => {
    setVisible(false)
    clearTimer()
  }, [clearTimer])

  const show = useCallback(() => {
    if (enabledRef.current && !enabledRef.current()) return
    clearTimer()
    setVisible(true)
    if (autoHideMs != null) {
      timerRef.current = window.setTimeout(() => {
        setVisible(false)
        timerRef.current = null
      }, autoHideMs)
    }
  }, [autoHideMs, clearTimer])

  const startTouch = useCallback(() => {
    if (enabledRef.current && !enabledRef.current()) return
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      setVisible(true)
      timerRef.current = null
    }, touchDelayMs)
  }, [touchDelayMs, clearTimer])

  useEffect(() => () => { clearTimer() }, [clearTimer])

  return { visible, show, hide, clearTimer, startTouch }
}
