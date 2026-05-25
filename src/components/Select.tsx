import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Option {
  label: ReactNode
  value: string | number
}

interface SelectProps {
  value: string | number
  onChange: (value: any) => void
  options: Option[]
  disabled?: boolean
  className?: string
  placement?: 'auto' | 'top' | 'bottom'
}

export default function Select({ value, onChange, options, disabled, className, placement = 'auto' }: SelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [openUp, setOpenUp] = useState(false)
  const [menuStyle, setMenuStyle] = useState<{ left: number; top: number; width: number }>({
    left: 0,
    top: 0,
    width: 0,
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find((o) => o.value === value)
  const arrowPointsUp = isOpen ? !openUp : placement === 'top'

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current?.contains(e.target as Node)
        || menuRef.current?.contains(e.target as Node)
      ) {
        return
      }
      if (containerRef.current) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const updateMenuPosition = useCallback((nextOpenUp: boolean) => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewportTop = window.visualViewport?.offsetTop ?? 0
    const viewportLeft = window.visualViewport?.offsetLeft ?? 0
    const estimatedMenuHeight = Math.min(options.length * 36 + 8, 240)
    const top = nextOpenUp
      ? Math.max(viewportTop + 8, rect.top - estimatedMenuHeight - 6)
      : rect.bottom + 6

    setMenuStyle({
      left: rect.left + viewportLeft,
      top,
      width: rect.width,
    })
  }, [options.length])

  const handleToggle = useCallback((e: React.MouseEvent) => {
    if (disabled) return
    e.stopPropagation()

    let nextOpenUp = openUp
    if (!isOpen && placement !== 'auto') {
      nextOpenUp = placement === 'top'
    } else if (!isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const viewportTop = window.visualViewport?.offsetTop ?? 0
      const viewportBottom = viewportTop + (window.visualViewport?.height ?? window.innerHeight)
      const spaceAbove = rect.top - viewportTop
      const spaceBelow = viewportBottom - rect.bottom
      const estimatedMenuHeight = Math.min(options.length * 36 + 8, 240)
      nextOpenUp = spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow
    }
    setOpenUp(nextOpenUp)
    if (!isOpen) updateMenuPosition(nextOpenUp)

    setIsOpen(!isOpen)
  }, [disabled, isOpen, openUp, options.length, placement, updateMenuPosition])

  useEffect(() => {
    if (!isOpen) return

    const syncPosition = () => updateMenuPosition(openUp)
    syncPosition()

    window.addEventListener('resize', syncPosition)
    window.addEventListener('scroll', syncPosition, true)
    window.visualViewport?.addEventListener('resize', syncPosition)
    window.visualViewport?.addEventListener('scroll', syncPosition)

    return () => {
      window.removeEventListener('resize', syncPosition)
      window.removeEventListener('scroll', syncPosition, true)
      window.visualViewport?.removeEventListener('resize', syncPosition)
      window.visualViewport?.removeEventListener('scroll', syncPosition)
    }
  }, [isOpen, openUp, updateMenuPosition])

  return (
    <div ref={containerRef} className="relative w-full">
      <div
        ref={triggerRef}
        onClick={handleToggle}
        className={`flex items-center justify-between gap-1 w-full cursor-pointer select-none ${className ?? ''} ${
          disabled ? '!opacity-50 !cursor-not-allowed !bg-gray-100/50 dark:!bg-white/[0.05]' : ''
        }`}
      >
        <span className="flex min-w-0 flex-1 items-center overflow-hidden">{selectedOption?.label ?? value}</span>
        <svg
          className={`w-3.5 h-3.5 flex-shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-200 ${arrowPointsUp ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {isOpen && createPortal(
        <div
          ref={menuRef}
          className={`glass-surface-strong select-menu-surface fixed z-[160] border border-gray-200/60 dark:border-white/[0.08] rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] overflow-hidden py-1 max-h-60 overflow-y-auto ring-1 ring-black/5 dark:ring-white/10 ${
            openUp ? 'animate-dropdown-up' : 'animate-dropdown-down'
          }`}
          style={{
            left: menuStyle.left,
            top: menuStyle.top,
            width: menuStyle.width,
          }}
        >
          {options.map((option) => (
            <div
              key={option.value}
              onClick={() => {
                onChange(option.value)
                setIsOpen(false)
              }}
              className={`px-3 py-2 text-xs cursor-pointer transition-colors ${
                option.value === value
                  ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.06]'
              }`}
            >
              <span className="block min-w-0">{option.label}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
