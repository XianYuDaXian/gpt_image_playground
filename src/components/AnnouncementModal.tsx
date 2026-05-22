import type { BackendReminderItem } from '../lib/backendSettings'

export default function AnnouncementModal({
  announcement,
  onClose,
}: {
  announcement: BackendReminderItem
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
      <div className="glass-overlay-soft absolute inset-0 animate-overlay-in" onClick={onClose} />
      <div className="glass-surface-strong relative z-10 w-full max-w-lg overflow-hidden rounded-3xl border border-white/50 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:ring-white/10">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">{announcement.title || '公告'}</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              每日最多弹出 {announcement.maxDailyShows} 次 · {announcement.startTime} - {announcement.endTime}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭公告"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto px-5 py-4">
          {announcement.imageDataUrl && (
            <img
              src={announcement.imageDataUrl}
              alt={announcement.title || '公告配图'}
              className="mb-4 max-h-80 w-full rounded-2xl object-cover"
            />
          )}
          <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-700 dark:text-gray-200">
            {announcement.message}
          </div>
        </div>
        <div className="border-t border-gray-100 px-5 py-4 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600"
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  )
}
