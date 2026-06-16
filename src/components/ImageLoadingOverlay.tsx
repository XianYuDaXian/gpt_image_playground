import {
  formatByteSize,
  getImageLoadStageLabel,
  resolveImageLoadPercent,
  type ImageLoadProgress,
} from '../lib/imageLoadProgress'

interface ImageLoadingOverlayProps {
  progress: ImageLoadProgress
  imageIndex?: number
  imageTotal?: number
  variant?: 'light' | 'dark'
}

export default function ImageLoadingOverlay({
  progress,
  imageIndex,
  imageTotal,
  variant = 'light',
}: ImageLoadingOverlayProps) {
  const percent = resolveImageLoadPercent(progress)
  const stageLabel = getImageLoadStageLabel(progress)
  const total = progress.totalBytes ?? progress.expectedBytes
  const isDark = variant === 'dark'

  const textClass = isDark ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'
  const subTextClass = isDark ? 'text-white/55' : 'text-gray-400 dark:text-gray-500'
  const trackClass = isDark ? 'bg-white/15' : 'bg-gray-200/80 dark:bg-white/10'
  const barClass = isDark ? 'bg-white/85' : 'bg-blue-500'

  return (
    <div className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-3 px-6 pointer-events-none">
      <svg className={`h-9 w-9 animate-spin ${isDark ? 'text-white/80' : 'text-blue-400'}`} fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>

      <div className={`w-full max-w-[14rem] text-center text-sm font-medium ${textClass}`}>
        {stageLabel}
      </div>

      {imageIndex != null && imageTotal != null && imageTotal > 1 && (
        <div className={`text-xs ${subTextClass}`}>
          第 {imageIndex} / {imageTotal} 张
        </div>
      )}

      <div className={`h-1.5 w-full max-w-[14rem] overflow-hidden rounded-full ${trackClass}`}>
        {percent != null ? (
          <div
            className={`h-full rounded-full transition-[width] duration-200 ${barClass}`}
            style={{ width: `${Math.max(percent, progress.stage === 'decoding' ? 100 : 4)}%` }}
          />
        ) : (
          <div className={`h-full w-2/5 animate-pulse rounded-full ${barClass}`} />
        )}
      </div>

      <div className={`text-xs tabular-nums ${subTextClass}`}>
        {total
          ? `${formatByteSize(progress.loadedBytes)} / ${formatByteSize(total)}`
          : progress.loadedBytes > 0
            ? `已下载 ${formatByteSize(progress.loadedBytes)}`
            : progress.stage === 'preparing'
              ? '等待图片地址'
              : '正在读取'}
      </div>
    </div>
  )
}