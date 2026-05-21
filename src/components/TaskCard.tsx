import { useEffect, useState, useRef } from 'react'
import type { TaskRecord, VideoTaskParams } from '../types'
import {
  cacheTaskVideoForPlayback,
  cacheTaskImageForEditing,
  ensureMediaThumbnailCached,
  ensureTaskImageAvailable,
  ensureTaskVideoAvailable,
  subscribeMediaThumbnail,
  updateTaskInStore,
  useStore,
} from '../store'
import { formatImageRatio } from '../lib/size'
import { ParamValue } from '../lib/paramDisplay'
import UsageCodeBadge from './UsageCodeBadge'
import ProviderProfileTag from './ProviderProfileTag'

interface Props {
  task: TaskRecord
  onReuse: () => void
  onEditOutputs: () => void
  onDelete: () => void
  onClick: (e: React.MouseEvent | React.TouchEvent) => void
  isSelected?: boolean
  deferImageLoading?: boolean
}

export default function TaskCard({
  task,
  onReuse,
  onEditOutputs,
  onDelete,
  onClick,
  isSelected,
  deferImageLoading = false,
}: Props) {
  const [thumbSrc, setThumbSrc] = useState<string>('')
  const [videoSrc, setVideoSrc] = useState<string>('')
  const [coverRatio, setCoverRatio] = useState<string>('')
  const [now, setNow] = useState(Date.now())
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)
  const [swipeStartedSelected, setSwipeStartedSelected] = useState(false)
  const [swipeActionActive, setSwipeActionActive] = useState(false)
  const toggleTaskSelection = useStore((s) => s.toggleTaskSelection)
  const authStatus = useStore((s) => s.authStatus)
  const loadedTaskImageIds = useStore((s) => s.loadedTaskImageIds)
  const markTaskImageLoaded = useStore((s) => s.markTaskImageLoaded)
  const blurLoadedImages = useStore((s) => s.blurLoadedImages)
  const taskImageBlurOverrides = useStore((s) => s.taskImageBlurOverrides)
  const toggleTaskImageBlur = useStore((s) => s.toggleTaskImageBlur)
  const firstOutputImageId = task.outputImages?.[0]
  const firstOutputVideoId = task.outputVideos?.[0]
  const firstOutputVideoRemoteUrl = firstOutputVideoId
    ? task.mediaUrlsById?.[firstOutputVideoId] || task.imageUrlsById?.[firstOutputVideoId] || ''
    : ''
  const firstOutputSize = firstOutputImageId ? task.imageSizesById?.[firstOutputImageId] : undefined
  const firstOutputImageLoaded = firstOutputImageId ? loadedTaskImageIds.includes(firstOutputImageId) : false
  const shouldLoadImage = Boolean(firstOutputImageId) && (!deferImageLoading || firstOutputImageLoaded)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeResetTimerRef = useRef<number | null>(null)
  const suppressClickUntilRef = useRef(0)
  const horizontalSwipeRef = useRef(false)
  const swipeLockRef = useRef<'horizontal' | 'vertical' | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressTriggeredRef = useRef(false)

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  const isPreviewImageTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement && Boolean(target.closest('img.saveable-image'))

  const handleTouchStart = (e: React.TouchEvent) => {
    if (swipeResetTimerRef.current != null) {
      window.clearTimeout(swipeResetTimerRef.current)
      swipeResetTimerRef.current = null
    }
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    horizontalSwipeRef.current = false
    swipeLockRef.current = null
    longPressTriggeredRef.current = false
    setSwipeStartedSelected(Boolean(isSelected))
    setSwipeActionActive(false)
    setIsSwiping(false)

    const target = e.target as HTMLElement | null
    if (
      !target?.closest('button, a, input, textarea, select, [data-no-long-press]') &&
      !isPreviewImageTarget(target)
    ) {
      clearLongPressTimer()
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true
        suppressClickUntilRef.current = Date.now() + 500
        touchStartRef.current = null
        horizontalSwipeRef.current = false
        swipeLockRef.current = null
        setIsSwiping(false)
        setSwipeOffset(0)
        setSwipeActionActive(true)
        toggleTaskSelection(task.id)
        swipeResetTimerRef.current = window.setTimeout(() => {
          setSwipeActionActive(false)
          swipeResetTimerRef.current = null
        }, 220)
      }, 420)
    }
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return
    const deltaX = e.touches[0].clientX - touchStartRef.current.x
    const deltaY = e.touches[0].clientY - touchStartRef.current.y
    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)

    if (absX > 6 || absY > 6) {
      clearLongPressTimer()
    }

    if (!swipeLockRef.current) {
      if (absY > 10 && absY > absX * 1.2) {
        swipeLockRef.current = 'vertical'
        horizontalSwipeRef.current = false
        setIsSwiping(false)
        setSwipeOffset(0)
        setSwipeActionActive(false)
        return
      }

      if (absX > 16 && absX > absY * 1.35) {
        swipeLockRef.current = 'horizontal'
        horizontalSwipeRef.current = true
        setIsSwiping(true)
      } else {
        return
      }
    }

    if (swipeLockRef.current === 'vertical') return

    // 水平方向明确后才接管卡片侧滑，避免拦截页面上下滚动。
    if (swipeLockRef.current === 'horizontal') {
      horizontalSwipeRef.current = true
      e.preventDefault()
      const boundedOffset = Math.max(-60, Math.min(60, deltaX))
      setSwipeOffset(boundedOffset)
      setSwipeActionActive(absX >= 40)
    }
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    clearLongPressTimer()
    setIsSwiping(false)
    setSwipeOffset(0)

    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false
      e.preventDefault()
      e.stopPropagation()
      return
    }
    
    if (!touchStartRef.current) return
    const deltaX = e.changedTouches[0].clientX - touchStartRef.current.x
    touchStartRef.current = null
    const lockedDirection = swipeLockRef.current
    swipeLockRef.current = null
    if (lockedDirection !== 'horizontal') {
      horizontalSwipeRef.current = false
      setSwipeActionActive(false)
      return
    }
    const isSwipeAction = horizontalSwipeRef.current && Math.abs(deltaX) > 40
    horizontalSwipeRef.current = false
    setSwipeActionActive(isSwipeAction)
    swipeResetTimerRef.current = window.setTimeout(() => {
      setSwipeActionActive(false)
      swipeResetTimerRef.current = null
    }, 220)

    // 如果是水平滑动，且垂直偏移较小，认为是滑动选择
    if (isSwipeAction) {
      suppressClickUntilRef.current = Date.now() + 350
      e.preventDefault()
      e.stopPropagation()
      toggleTaskSelection(task.id)
    }
  }

  const handleTouchCancel = () => {
    clearLongPressTimer()
    longPressTriggeredRef.current = false
    touchStartRef.current = null
    horizontalSwipeRef.current = false
    swipeLockRef.current = null
    setIsSwiping(false)
    setSwipeOffset(0)
    setSwipeActionActive(false)
  }

  useEffect(() => () => {
    clearLongPressTimer()
    if (swipeResetTimerRef.current != null) {
      window.clearTimeout(swipeResetTimerRef.current)
    }
  }, [])

  // 定时更新运行中任务的计时
  useEffect(() => {
    if (task.status !== 'running') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [task.status])

  // 加载缩略图
  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    setCoverRatio('')
    setThumbSrc('')
    setVideoSrc('')

    const mediaId = task.taskType === 'video' ? firstOutputVideoId : task.outputImages?.[0]
    if (mediaId && (task.taskType === 'video' || shouldLoadImage)) {
      unsubscribe = subscribeMediaThumbnail(mediaId, (thumbnail) => {
        if (cancelled) return
        setThumbSrc(thumbnail.dataUrl)
        if (!firstOutputSize?.width && !firstOutputSize?.height && thumbnail.width && thumbnail.height) {
          setCoverRatio(formatImageRatio(thumbnail.width, thumbnail.height))
        }
      })

      ensureMediaThumbnailCached(mediaId).then((thumbnail) => {
        if (cancelled || !thumbnail) return
        setThumbSrc(thumbnail.dataUrl)
        if (!firstOutputSize?.width && !firstOutputSize?.height && thumbnail.width && thumbnail.height) {
          setCoverRatio(formatImageRatio(thumbnail.width, thumbnail.height))
        }
      })
    }

    const imageId = task.outputImages?.[0]
    if (imageId && shouldLoadImage) {
      const remoteUrl = task.imageUrlsById?.[imageId]
      if (remoteUrl) {
        setThumbSrc((prev) => prev || remoteUrl)
      } else {
        ensureTaskImageAvailable(imageId).then((url) => {
          if (!cancelled && url) setThumbSrc((prev) => prev || url)
        })
      }
    }

    if (task.taskType === 'video' && firstOutputVideoId) {
      ensureTaskVideoAvailable(firstOutputVideoId).then((url) => {
        if (!cancelled && url) setVideoSrc(url)
      })

      if (firstOutputVideoRemoteUrl) {
        void cacheTaskVideoForPlayback(firstOutputVideoId, firstOutputVideoRemoteUrl).then((url) => {
          if (!cancelled && url) setVideoSrc(url)
        })
      }
    }

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [
    firstOutputSize?.height,
    firstOutputSize?.width,
    firstOutputVideoId,
    firstOutputVideoRemoteUrl,
    shouldLoadImage,
    task.imageUrlsById,
    task.outputImages,
    task.taskType,
  ])

  useEffect(() => {
    if (firstOutputSize?.width && firstOutputSize.height) {
      setCoverRatio(formatImageRatio(firstOutputSize.width, firstOutputSize.height))
    }
  }, [firstOutputSize?.height, firstOutputSize?.width])

  useEffect(() => {
    if (firstOutputSize?.width && firstOutputSize.height) return
    if (!firstOutputImageId || !shouldLoadImage) return
    const remoteUrl = task.imageUrlsById?.[firstOutputImageId]
    if (!remoteUrl) return

    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
        setCoverRatio(formatImageRatio(image.naturalWidth, image.naturalHeight))
      }
    }
    image.src = remoteUrl

    return () => {
      cancelled = true
    }
  }, [firstOutputImageId, firstOutputSize?.height, firstOutputSize?.width, shouldLoadImage, task.imageUrlsById])

  useEffect(() => {
    if (!thumbSrc) return

    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled && !firstOutputSize?.width && !firstOutputSize?.height && image.naturalWidth > 0 && image.naturalHeight > 0) {
        setCoverRatio(formatImageRatio(image.naturalWidth, image.naturalHeight))
      }
    }
    image.src = thumbSrc
    if (!firstOutputSize?.width && !firstOutputSize?.height && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      setCoverRatio(formatImageRatio(image.naturalWidth, image.naturalHeight))
    }

    return () => {
      cancelled = true
    }
  }, [firstOutputSize?.height, firstOutputSize?.width, thumbSrc])

  const duration = (() => {
    let seconds: number
    if (task.status === 'running') {
      seconds = Math.floor((now - task.createdAt) / 1000)
    } else if (task.elapsed != null) {
      seconds = Math.floor(task.elapsed / 1000)
    } else {
      return '00:00'
    }
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  })()
  const aggregateActualParams = task.outputImages?.length
    ? { ...task.actualParams, n: task.outputImages.length }
    : task.actualParams
  const hasOutputImage = Boolean(task.outputImages?.length)
  const hasOutputVideo = Boolean(task.outputVideos?.length)
  const isVideoTask = task.taskType === 'video'
  const videoParams = isVideoTask ? task.params as VideoTaskParams : null
  const taskSourceLabel = task.providerProfileName ?? task.providerProfileId ?? null
  const taskModelLabel = task.providerProfileModel ?? null
  const videoPreviewSrc = videoSrc ? `${videoSrc}#t=0.001` : ''
  const isSwipeReady = Math.abs(swipeOffset) >= 40
  const showSwipeAction = isSwipeReady || swipeActionActive
  const showDeferredPlaceholder =
    task.status === 'done' && hasOutputImage && Boolean(firstOutputImageId) && deferImageLoading && !firstOutputImageLoaded
  const isCoverBlurred = Boolean(thumbSrc) && (taskImageBlurOverrides[task.id] ?? blurLoadedImages)
  const swipeBgClass = showSwipeAction
    ? swipeStartedSelected
      ? 'bg-gray-500 dark:bg-gray-600'
      : 'bg-blue-500'
    : 'bg-gray-200 dark:bg-gray-700'

  return (
    <div className="relative rounded-xl">
      {/* 侧滑底图 */}
      <div
        className={`absolute inset-0 rounded-xl flex items-center transition-opacity duration-200 pointer-events-none ${
          isSwiping || swipeOffset || swipeActionActive ? 'opacity-100' : 'opacity-0'
        } ${swipeBgClass} ${
          swipeOffset > 0 ? 'justify-start pl-6' : 'justify-end pr-6'
        }`}
      >
        <svg className={`w-8 h-8 transition-transform duration-150 ${showSwipeAction ? 'scale-110 text-white' : 'scale-90 text-white/60'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {swipeStartedSelected && showSwipeAction ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          )}
        </svg>
      </div>

      <div
        className={`relative bg-white dark:bg-gray-900 rounded-xl border overflow-hidden cursor-pointer duration-200 hover:shadow-lg dark:hover:bg-gray-800/80 ${
          !isSwiping ? 'transition-[box-shadow,border-color,background-color,transform]' : 'transition-[box-shadow,border-color,background-color]'
        } ${
          task.status === 'running'
            ? 'border-blue-400 generating'
            : isSelected
            ? 'border-blue-500 shadow-md ring-2 ring-blue-500/50'
            : 'border-gray-200 dark:border-white/[0.08] hover:border-gray-300 dark:hover:border-white/[0.18]'
        }`}
        style={{
          transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
          touchAction: 'pan-y',
        }}
        onClick={(e) => {
          if (Date.now() < suppressClickUntilRef.current) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          if (showDeferredPlaceholder && firstOutputImageId) {
            e.preventDefault()
            e.stopPropagation()
            markTaskImageLoaded(firstOutputImageId)
            return
          }
          onClick(e)
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onContextMenu={(e) => {
          if (isPreviewImageTarget(e.target)) {
            suppressClickUntilRef.current = Date.now() + 800
            return
          }
          e.preventDefault()
        }}
      >
        {/* 选中时的角标 */}
      {isSelected && (
        <div className="absolute top-2 right-9 z-10 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center shadow-sm">
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      )}
      {(hasOutputImage || hasOutputVideo) && (
        <button
          type="button"
          data-no-long-press
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            toggleTaskImageBlur(task.id)
          }}
          className={`absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur transition ${
            isCoverBlurred
              ? 'border-blue-300/70 bg-blue-500/80 text-white'
              : 'border-white/30 bg-black/40 text-white/80 hover:bg-black/55'
          }`}
          title={isCoverBlurred ? '取消模糊预览图' : '模糊预览图'}
        >
          {isCoverBlurred ? (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          ) : (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M3 3l18 18" />
              <path d="M10.6 10.6A2 2 0 0012 14a2 2 0 001.4-.6" />
              <path d="M9.9 5.2A10.6 10.6 0 0112 5c6.5 0 10 7 10 7a17.9 17.9 0 01-3.1 4.2" />
              <path d="M6.1 6.7A18.1 18.1 0 002 12s3.5 7 10 7a10.8 10.8 0 004.7-1.1" />
            </svg>
          )}
        </button>
      )}
      <div className="flex h-40">
        {/* 左侧图片区域 */}
        <div className="w-40 min-w-[10rem] h-full bg-gray-100 dark:bg-black/20 relative flex items-center justify-center overflow-hidden flex-shrink-0">
          {isVideoTask && thumbSrc && (
            <>
              <img
                src={thumbSrc}
                className={`h-full w-full object-cover transition duration-200 ${isCoverBlurred ? 'scale-[1.03] blur-md' : ''}`}
                alt=""
              />
              <div className="absolute inset-0 bg-black/20" />
            </>
          )}
          {isVideoTask && !thumbSrc && videoSrc && (
            <>
              <video
                src={videoPreviewSrc}
                className="h-full w-full object-cover"
                muted
                playsInline
                preload="auto"
              />
              <div className="absolute inset-0 bg-black/20" />
            </>
          )}
          {hasOutputVideo && (
            <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-black/45 text-white shadow-lg backdrop-blur-sm">
                <svg className="ml-0.5 h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 6.5v11l9-5.5-9-5.5z" />
                </svg>
              </div>
            </div>
          )}
          {hasOutputImage && thumbSrc && !isVideoTask && (
            <>
              <img
                src={thumbSrc}
                data-image-id={task.outputImages[0]}
                data-original-src={task.imageUrlsById?.[task.outputImages[0]]}
                className={`saveable-image w-full h-full object-cover transition duration-200 ${isCoverBlurred ? 'scale-[1.03] blur-md' : ''}`}
                loading="lazy"
                onLoad={(event) => {
                  if (task.outputImages[0]) {
                    markTaskImageLoaded(task.outputImages[0])
                  }
                  const remoteUrl = task.imageUrlsById?.[task.outputImages[0]]
                  if (!remoteUrl || !task.outputImages[0]) return
                  void cacheTaskImageForEditing(task.outputImages[0], remoteUrl, event.currentTarget)
                }}
                alt=""
              />
              {task.outputImages.length > 1 && (
                <span className="absolute bottom-1 right-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
                  {task.outputImages.length}
                </span>
              )}
            </>
          )}
          {showDeferredPlaceholder && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-gray-100 text-gray-500 transition hover:bg-gray-200 dark:bg-black/20 dark:text-gray-300 dark:hover:bg-black/30"
              title="点击加载图片"
            >
              <svg className="w-9 h-9" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3v11m0 0l-4-4m4 4l4-4M5 17v1a2 2 0 002 2h10a2 2 0 002-2v-1" />
              </svg>
              <span className="rounded-full bg-white/85 px-2.5 py-1 text-xs font-medium text-gray-600 shadow-sm dark:bg-white/10 dark:text-gray-200">
                点击加载
              </span>
            </div>
          )}
          {task.status === 'running' && !hasOutputImage && !hasOutputVideo && (
            <div className="flex flex-col items-center gap-2">
              <svg
                className="w-8 h-8 text-blue-400 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {task.progressPercent != null ? `${task.progressPercent}%` : task.currentStep ? `${task.currentStep}...` : '生成中...'}
              </span>
            </div>
          )}
          {task.status === 'error' && !hasOutputImage && !hasOutputVideo && (
            <div className="flex flex-col items-center gap-1 px-2">
              <svg
                className="w-7 h-7 text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="text-xs text-red-400 text-center leading-tight">
                失败
              </span>
            </div>
          )}
          {task.status === 'done' && !thumbSrc && !videoSrc && (
            <svg
              className="w-8 h-8 text-gray-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          )}
          {/* 运行中显示耗时，完成后显示封面图比例 */}
          <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
            {isVideoTask ? (
              <>
                <span className="bg-black/50 text-white text-[10px] sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm">
                  视频
                </span>
              <span className="bg-black/50 text-white text-[10px] sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm font-mono">
                {videoParams?.aspect_ratio ?? 'auto'}
              </span>
              </>
            ) : task.status !== 'done' || !hasOutputImage || !coverRatio ? (
              <span className="flex items-center gap-1 bg-black/50 text-white text-[10px] sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm font-mono">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {duration}
              </span>
            ) : (
              <span className="bg-black/50 text-white text-[10px] sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm font-mono">
                {coverRatio}
              </span>
            )}
          </div>
          {task.status === 'running' && (hasOutputImage || hasOutputVideo) && task.currentStep && (
            <div className="absolute bottom-1.5 left-1.5 right-1.5">
              <span className="inline-flex max-w-full rounded bg-black/55 px-2 py-1 text-[10px] text-white/90 backdrop-blur-sm">
                {task.currentStep}
              </span>
            </div>
          )}
        </div>

        {/* 右侧信息区域 */}
        <div className="flex-1 p-3 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 mb-2 overflow-hidden">
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed line-clamp-3">
              {task.prompt || '(无提示词)'}
            </p>
          </div>
          <div className="mt-auto flex flex-col gap-1.5">
            {/* 参数：横向滚动 */}
            <div
              className="flex overflow-x-auto tiny-scrollbar gap-1.5 whitespace-nowrap mask-edge-r min-w-0 pr-2 pb-1.5 pt-0.5"
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
              onTouchCancel={(e) => e.stopPropagation()}
            >
              {isVideoTask ? (
                <>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 flex-shrink-0">视频</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 flex-shrink-0">{videoParams?.aspect_ratio ?? 'auto'}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 flex-shrink-0">{videoParams?.resolution ?? '480p'}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 flex-shrink-0">{videoParams?.duration ?? 6}s</span>
                </>
              ) : (
                <>
                  <ParamValue task={task} paramKey="quality" className="text-xs px-1.5 py-0.5 rounded flex-shrink-0" />
                  <ParamValue task={task} paramKey="size" className="text-xs px-1.5 py-0.5 rounded flex-shrink-0" />
                  <ParamValue task={task} paramKey="output_format" className="text-xs px-1.5 py-0.5 rounded flex-shrink-0" />
                  <ParamValue task={task} paramKey="n" className="text-xs px-1.5 py-0.5 rounded flex-shrink-0" actualParams={aggregateActualParams} />
                </>
              )}
              {task.maskImageId && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 flex-shrink-0">
                  mask
                </span>
              )}
              {taskSourceLabel && (
                <ProviderProfileTag
                  name={taskSourceLabel}
                  colorKey={task.providerProfileId ?? taskSourceLabel}
                  tagColor={task.providerProfileTagColor}
                  includeMode={false}
                  includeDefault={false}
                  className="max-w-[7rem] flex-shrink-0 rounded px-1.5 py-0.5 text-xs leading-4"
                />
              )}
              {taskModelLabel && (
                <span
                  className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-300 flex-shrink-0"
                  title={taskModelLabel}
                >
                  {taskModelLabel}
                </span>
              )}
              {task.ownerLabel && (
                <UsageCodeBadge task={task} />
              )}
              </div>
            {/* 操作按钮 */}
            <div
              className="flex gap-1 justify-end flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() =>
                  updateTaskInStore(task.id, { isFavorite: !task.isFavorite })
                }
                className={`p-1.5 rounded-md transition ${
                  task.isFavorite
                    ? 'text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'
                    : 'text-gray-400 hover:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'
                }`}
                title={task.isFavorite ? '取消收藏' : '收藏记录'}
              >
                <svg
                  className="w-4 h-4"
                  fill={task.isFavorite ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                  />
                </svg>
              </button>
              <button
                onClick={() =>
                  updateTaskInStore(task.id, { isArchived: !task.isArchived })
                }
                className={`p-1.5 rounded-md transition ${
                  task.isArchived
                    ? 'text-slate-500 hover:bg-slate-100 dark:hover:bg-white/[0.06]'
                    : 'text-gray-400 hover:text-slate-500 hover:bg-slate-100 dark:hover:bg-white/[0.06]'
                }`}
                title={task.isArchived ? '取消归档' : '归档记录'}
              >
                <svg className="w-4 h-4" fill={task.isArchived ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <rect x="4" y="4" width="16" height="5" rx="1" />
                  <path d="M6 9v10a1 1 0 001 1h10a1 1 0 001-1V9" />
                  <path d="M10 13h4" />
                </svg>
              </button>
              <button
                onClick={onReuse}
                className="p-1.5 rounded-md hover:bg-blue-50 dark:hover:bg-blue-950/30 text-gray-400 hover:text-blue-500 transition"
                title="复用配置"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
                  />
                </svg>
              </button>
              <button
                onClick={onEditOutputs}
                className="p-1.5 rounded-md hover:bg-green-50 dark:hover:bg-green-950/30 text-gray-400 hover:text-green-500 transition disabled:opacity-30"
                title="编辑输出"
                disabled={!task.outputImages?.length}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
              </button>
              <button
                onClick={onDelete}
                className="p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-950/30 text-gray-400 hover:text-red-500 transition"
                title="删除记录"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
