import { useEffect } from 'react'
import type { BackendReminderItem } from '../lib/backendSettings'
import { preloadAnnouncementImages, useAnnouncementImageSources } from '../lib/announcementImageCache'
import { renderTextWithLinks } from '../lib/linkify'

function formatLocalDateTime(value: string) {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return value
  return new Date(value).toLocaleString('zh-CN')
}

function getAnnouncementState(item: BackendReminderItem) {
  const now = Date.now()
  const startAt = new Date(item.startAt).getTime()
  const endAt = new Date(item.endAt).getTime()
  if (!item.enabled) return '已关闭'
  if (Number.isFinite(startAt) && now < startAt) return '未开始'
  if (Number.isFinite(endAt) && now > endAt) return '已结束'
  return '进行中'
}

export default function AnnouncementListModal({
  items,
  loading,
  error,
  onRefresh,
  onSelect,
  onClose,
}: {
  items: BackendReminderItem[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onSelect: (item: BackendReminderItem) => void
  onClose: () => void
}) {
  const orderedItems = [...items]
    .filter((item) => item.message.trim())
    .sort((left, right) =>
      new Date(right.updatedAt ?? right.startAt).getTime() - new Date(left.updatedAt ?? left.startAt).getTime(),
    )
    .slice(0, 30)
  const previewUrls = orderedItems
    .map((item) => item.imageDataUrls?.[0] ?? item.imageDataUrl ?? '')
    .filter(Boolean)
  const resolvedImageSources = useAnnouncementImageSources(previewUrls)

  useEffect(() => {
    preloadAnnouncementImages(previewUrls)
  }, [previewUrls.join('\n')])

  return (
    <div className="fixed inset-0 z-[72] flex items-center justify-center p-4">
      <div className="glass-overlay-soft absolute inset-0 animate-overlay-in" onClick={onClose} />
      <div className="glass-surface-strong relative z-10 flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-white/50 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:ring-white/10">
        <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">最近公告</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">点击任意公告可重新查看。</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="rounded-lg bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500 transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
            >
              刷新
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭最近公告"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="tiny-scrollbar flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="rounded-2xl border border-dashed border-gray-200/70 bg-white/30 px-4 py-8 text-center text-sm text-gray-400 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-500">
              正在读取公告
            </div>
          ) : error ? (
            <div className="space-y-3 rounded-2xl border border-red-200/70 bg-red-50/50 px-4 py-4 text-sm text-red-500 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              <div>{error}</div>
              <button
                type="button"
                onClick={onRefresh}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-600"
              >
                重新读取
              </button>
            </div>
          ) : orderedItems.length ? (
            <div className="space-y-3">
              {orderedItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item)}
                  className="block w-full rounded-2xl border border-gray-200/70 bg-white/60 p-3 text-left transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:bg-white/[0.07]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{item.title || '公告'}</div>
                      <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                        {getAnnouncementState(item)} · {formatLocalDateTime(item.startAt)}
                      </div>
                    </div>
                    {item.imageDataUrls?.length ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <img
                          src={resolvedImageSources[item.imageDataUrls[0] ?? item.imageDataUrl ?? ''] ?? item.imageDataUrls[0] ?? item.imageDataUrl ?? ''}
                          alt=""
                          className="h-10 w-10 rounded-lg object-cover"
                          draggable={false}
                        />
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-500 dark:bg-blue-500/10 dark:text-blue-300">
                          {item.imageDataUrls.length} 图
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-2 line-clamp-2 break-words text-xs leading-5 text-gray-500 dark:text-gray-400">
                    {renderTextWithLinks(item.message.trim())}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-gray-200/70 bg-white/30 px-4 py-8 text-center text-sm text-gray-400 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-gray-500">
              暂无可查看公告
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
