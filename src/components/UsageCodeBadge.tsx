import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TaskRecord } from '../types'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { formatUsageCodeTooltip } from '../lib/usageCodeDisplay'
import { useStore } from '../store'

export default function UsageCodeBadge({ task }: { task: TaskRecord }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const authStatus = useStore((state) => state.authStatus)
  const showUsageCodeAliasOnTaskCard = useStore((state) => state.settings.showUsageCodeAliasOnTaskCard)
  const showToast = useStore((state) => state.showToast)
  const buttonRef = useRef<HTMLButtonElement>(null)
  if (!task.ownerLabel) return null

  const showAlias = authStatus?.role === 'admin' && showUsageCodeAliasOnTaskCard
  const displayText = showAlias
    ? (task.ownerUsageCode?.name ?? task.ownerLabel)
    : (task.ownerUsageCode?.code ?? task.ownerLabel)
  const copyText = task.ownerUsageCode?.code ?? task.ownerLabel
  const detail = formatUsageCodeTooltip(task)
  const updatePosition = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return false
    const width = 256
    const gap = 8
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    const top = rect.bottom + gap + 160 > window.innerHeight
      ? Math.max(8, rect.top - gap - 160)
      : rect.bottom + gap
    setPosition({ left, top })
    return true
  }

  const openDetail = () => {
    if (!updatePosition()) return
    setOpen(true)
  }

  const handleCopy = async () => {
    if (!copyText) return
    try {
      await copyTextToClipboard(copyText)
      showToast('分发码已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制分发码失败', err), 'error')
    }
  }

  return (
    <span className="inline-flex">
      <button
        ref={buttonRef}
        type="button"
        title="点击复制分发码"
        onClick={(event) => {
          event.stopPropagation()
          void handleCopy()
        }}
        onMouseEnter={openDetail}
        onMouseLeave={() => setOpen(false)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        className="inline-flex max-w-full items-center rounded-lg bg-gray-100 px-2 py-1 font-mono text-xs font-semibold text-gray-700 transition hover:bg-gray-200 dark:bg-white/[0.07] dark:text-gray-200 dark:hover:bg-white/[0.12]"
      >
        <span className="truncate">{displayText}</span>
      </button>
      {open && createPortal(
        <span
          title=""
          className="fixed z-[90] w-64 whitespace-pre-line rounded-xl border border-gray-200 bg-white p-3 text-left text-xs leading-relaxed text-gray-700 shadow-xl dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-200"
          style={{ left: position.left, top: position.top }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {detail}
        </span>,
        document.body,
      )}
    </span>
  )
}
