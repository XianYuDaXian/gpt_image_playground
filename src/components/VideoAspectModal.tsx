import type { VideoTaskParams } from '../types'

const ASPECTS: Array<{ label: string; value: VideoTaskParams['aspect_ratio'] }> = [
  { label: 'auto', value: 'auto' },
  { label: '1:1', value: '1:1' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
  { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' },
]

interface Props {
  currentAspect: VideoTaskParams['aspect_ratio']
  hasReferenceImage: boolean
  onSelect: (aspect: VideoTaskParams['aspect_ratio']) => void
  onClose: () => void
}

export default function VideoAspectModal({ currentAspect, hasReferenceImage, onSelect, onClose }: Props) {
  const buttonClass = (active: boolean, disabled: boolean) => `rounded-xl border px-3 py-2 text-sm font-medium transition ${
    disabled
      ? 'cursor-not-allowed border-gray-200/60 bg-gray-100/70 text-gray-400 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-gray-600'
      :
    active
      ? 'border-blue-400 bg-blue-50 text-blue-600 dark:border-blue-500/50 dark:bg-blue-500/10 dark:text-blue-300'
      : 'border-gray-200/70 bg-white/60 text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]'
  }`

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-overlay-soft absolute inset-0 animate-overlay-in" />
      <div
        className="relative z-10 w-full max-w-sm rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">设置视频比例</h3>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              当前：{currentAspect}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          {hasReferenceImage && (
            <div className="rounded-2xl bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
              已添加参考图，视频比例将使用 auto，不向远端传比例。
            </div>
          )}
          <div>
            <span className="mb-2 block text-xs text-gray-500 dark:text-gray-400">视频比例</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {ASPECTS.map((aspect) => {
                const disabled = hasReferenceImage && aspect.value !== 'auto'
                return (
                  <button
                    key={aspect.value}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return
                      onSelect(aspect.value)
                      onClose()
                    }}
                    className={buttonClass(currentAspect === aspect.value, disabled)}
                  >
                    {aspect.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
