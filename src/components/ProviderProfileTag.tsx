import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AppSettings } from '../types'

const PROVIDER_TAG_STYLE_MAP = {
  rose: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/20',
  orange: 'bg-orange-500/15 text-orange-300 ring-1 ring-orange-400/20',
  amber: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/20',
  lime: 'bg-lime-500/15 text-lime-300 ring-1 ring-lime-400/20',
  emerald: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/20',
  cyan: 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-400/20',
  sky: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/20',
  blue: 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-400/20',
  violet: 'bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/20',
  fuchsia: 'bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-fuchsia-400/20',
} as const

type ProviderTagColor = keyof typeof PROVIDER_TAG_STYLE_MAP
const PROVIDER_TAG_STYLES = Object.values(PROVIDER_TAG_STYLE_MAP)

function hashProviderKey(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33 + value.charCodeAt(index)) >>> 0
  }
  return hash
}

export function getProviderProfileTagClass(colorKey: string, tagColor?: string | null) {
  if (tagColor && tagColor in PROVIDER_TAG_STYLE_MAP) {
    return PROVIDER_TAG_STYLE_MAP[tagColor as ProviderTagColor]
  }
  return PROVIDER_TAG_STYLES[hashProviderKey(colorKey) % PROVIDER_TAG_STYLES.length] ?? PROVIDER_TAG_STYLES[0]
}

export function formatProviderProfileTagText(input: {
  name: string
  apiMode?: AppSettings['apiMode'] | null
  isDefault?: boolean
  includeMode?: boolean
  includeDefault?: boolean
}) {
  const parts: string[] = []
  if (input.includeDefault !== false && input.isDefault) {
    parts.push('默认')
  }
  if (input.includeMode !== false && input.apiMode) {
    parts.push(input.apiMode === 'videos' ? '视频' : '图片')
  }
  parts.push(input.name)
  return parts.join(' · ')
}

export default function ProviderProfileTag(props: {
  name: string
  colorKey: string
  tagColor?: string | null
  apiMode?: AppSettings['apiMode'] | null
  isDefault?: boolean
  includeMode?: boolean
  includeDefault?: boolean
  text?: string
  className?: string
  disabled?: boolean
  crossed?: boolean
  detail?: ReactNode
  content?: ReactNode
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const tagRef = useRef<HTMLButtonElement | HTMLSpanElement>(null)
  const text = props.text ?? formatProviderProfileTagText(props)
  const hasDetail = Boolean(props.detail)

  const updatePosition = () => {
    const rect = tagRef.current?.getBoundingClientRect()
    if (!rect) return false
    const width = 256
    const estimatedHeight = 120
    const gap = 8
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - width / 2),
      Math.max(8, window.innerWidth - width - 8),
    )
    const top = rect.bottom + gap + estimatedHeight > window.innerHeight
      ? Math.max(8, rect.top - gap - estimatedHeight)
      : rect.bottom + gap
    setPosition({ left, top })
    return true
  }

  const openDetail = () => {
    if (!hasDetail) return
    if (!updatePosition()) return
    setOpen(true)
  }

  const closeDetail = () => {
    if (!hasDetail) return
    setOpen(false)
  }

  const toggleDetail = () => {
    if (!hasDetail) return
    if (!updatePosition()) return
    setOpen((value) => !value)
  }

  useEffect(() => {
    if (!open) return

    const handleDismiss = () => {
      setOpen(false)
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (tagRef.current?.contains(event.target as Node)) return
      handleDismiss()
    }

    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('touchmove', handleDismiss, { capture: true, passive: true })
    window.addEventListener('wheel', handleDismiss, { capture: true, passive: true })
    window.addEventListener('scroll', handleDismiss, true)
    window.addEventListener('resize', handleDismiss)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('touchmove', handleDismiss, true)
      window.removeEventListener('wheel', handleDismiss, true)
      window.removeEventListener('scroll', handleDismiss, true)
      window.removeEventListener('resize', handleDismiss)
    }
  }, [open])

  const sizeClass = props.compact
    ? 'px-2 py-0.5 text-[11px] leading-4'
    : 'px-2.5 py-1 text-xs leading-4'

  const content = (
    <>
      {(props.crossed ?? props.disabled) && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 top-1/2 h-px -rotate-[18deg] bg-current/80"
        />
      )}
      {props.content ?? <span className="block max-w-full truncate">{text}</span>}
    </>
  )

  if (hasDetail) {
    return (
      <>
        <button
          ref={tagRef as React.RefObject<HTMLButtonElement>}
          type="button"
          onMouseEnter={openDetail}
          onMouseLeave={closeDetail}
          onFocus={openDetail}
          onBlur={() => window.setTimeout(closeDetail, 120)}
          onClick={(event) => {
            event.stopPropagation()
            toggleDetail()
          }}
          className={`relative inline-flex min-w-0 max-w-full items-center overflow-hidden rounded-full font-medium ${sizeClass} ${getProviderProfileTagClass(props.colorKey, props.tagColor)} ${props.disabled ? 'opacity-45 saturate-50' : ''} ${props.className ?? ''}`}
        >
          {content}
        </button>
        {open && createPortal(
          <div
            className="fixed z-[100] w-64 whitespace-pre-line rounded-xl border border-gray-200 bg-white p-3 text-left text-xs leading-6 text-gray-700 shadow-xl dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-200"
            style={{ left: position.left, top: position.top }}
            onMouseEnter={openDetail}
            onMouseLeave={closeDetail}
          >
            {props.detail}
          </div>,
          document.body,
        )}
      </>
    )
  }

  return (
    <span
      ref={tagRef as React.RefObject<HTMLSpanElement>}
      className={`relative inline-flex min-w-0 max-w-full items-center overflow-hidden rounded-full font-medium ${sizeClass} ${getProviderProfileTagClass(props.colorKey, props.tagColor)} ${props.disabled ? 'opacity-45 saturate-50' : ''} ${props.className ?? ''}`}
    >
      {content}
    </span>
  )
}
