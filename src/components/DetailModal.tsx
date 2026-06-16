import { useCallback, useEffect, useState, useMemo, useRef, type SyntheticEvent } from 'react'
import { useStore, cacheTaskImageForEditing, cacheTaskVideoForPlayback, getCachedImage, ensureTaskImageAvailable, ensureTaskVideoAvailable, reuseConfig, removeTask, updateTaskInStore, showCodexCliPrompt, getCodexCliPromptKey } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import DetailOutputImageCarousel from './DetailOutputImageCarousel'
import type { ImageCarouselHandle } from '../lib/touchGesture'
import { formatImageRatio } from '../lib/size'
import { ActualValueBadge, DetailParamValue } from '../lib/paramDisplay'
import { copyBlobToClipboard, copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import UsageCodeBadge from './UsageCodeBadge'
import VideoPlayer from './VideoPlayer'
import type { VideoTaskParams } from '../types'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}

function resolveTaskImageSrc(
  imageId: string,
  imageSrcs: Record<string, string>,
  task?: {
    imageUrlsById?: Record<string, string>
    imagePreviewUrlsById?: Record<string, string>
  } | null,
) {
  if (!imageId || !task) return ''
  return imageSrcs[imageId] || task.imageUrlsById?.[imageId] || task.imagePreviewUrlsById?.[imageId] || ''
}

export default function DetailModal() {
  const tasks = useStore((s) => s.tasks)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setLightboxStartEditor = useStore((s) => s.setLightboxStartEditor)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const settings = useStore((s) => s.settings)
  const authStatus = useStore((s) => s.authStatus)
  const dismissedCodexCliPrompts = useStore((s) => s.dismissedCodexCliPrompts)
  const blurLoadedImages = useStore((s) => s.blurLoadedImages)
  const taskImageBlurOverrides = useStore((s) => s.taskImageBlurOverrides)
  const toggleTaskImageBlur = useStore((s) => s.toggleTaskImageBlur)

  const [imageIndex, setImageIndex] = useState(0)
  const [imageSrcs, setImageSrcs] = useState<Record<string, string>>({})
  const [videoSrcs, setVideoSrcs] = useState<Record<string, string>>({})
  const [imageRatios, setImageRatios] = useState<Record<string, string>>({})
  const [imageSizes, setImageSizes] = useState<Record<string, string>>({})
  const [maskPreviewSrc, setMaskPreviewSrc] = useState('')
  const [now, setNow] = useState(Date.now())
  const [isTaskIdPopoverOpen, setIsTaskIdPopoverOpen] = useState(false)
  const imagePanelRef = useRef<HTMLDivElement>(null)
  const carouselRef = useRef<ImageCarouselHandle>(null)
  const taskIdPopoverRef = useRef<HTMLDivElement>(null)
  const [imageLabelLeft, setImageLabelLeft] = useState(8)
  const useNativeVideoControls = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    const ua = navigator.userAgent || ''
    const isIPhone = /iPhone/i.test(ua)
    const isSafariEngine = /Safari/i.test(ua) && /Version\/[\d.]+/i.test(ua)
    const isOtherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|DuckDuckGo|Puffin|Mercury/i.test(ua)
    return isIPhone && isSafariEngine && !isOtherIosBrowser
  }, [])

  const task = useMemo(
    () => tasks.find((t) => t.id === detailTaskId) ?? null,
    [tasks, detailTaskId],
  )
  const isUsageCodeUser = authStatus?.role === 'user'

  useCloseOnEscape(Boolean(task), () => setDetailTaskId(null))

  // Reset index when task changes
  useEffect(() => {
    setImageIndex(0)
  }, [detailTaskId])

  useEffect(() => {
    if (task?.status !== 'running') return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [task?.status])

  useEffect(() => {
    setIsTaskIdPopoverOpen(false)
  }, [detailTaskId])

  useEffect(() => {
    if (!isTaskIdPopoverOpen) return

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (taskIdPopoverRef.current?.contains(target)) return
      setIsTaskIdPopoverOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
    }
  }, [isTaskIdPopoverOpen])

  // 加载所有相关图片
  useEffect(() => {
    if (!task) {
      setImageSrcs({})
      setVideoSrcs({})
      return
    }

    let cancelled = false
    const ids = [...new Set([
      ...(task.outputImages || []),
      ...(task.outputVideos || []),
      ...(task.inputImageIds || []),
      ...(task.maskImageId ? [task.maskImageId] : []),
    ])]
    const initial: Record<string, string> = {}
    for (const id of ids) {
      const posterUrl = task.outputVideos?.includes(id) ? task.videoPosterUrlsById?.[id] : undefined
      if (posterUrl) {
        initial[id] = posterUrl
        continue
      }
      const remoteUrl = task.imageUrlsById?.[id]
      if (remoteUrl) {
        initial[id] = remoteUrl
        continue
      }
      const cached = getCachedImage(id)
      if (cached) initial[id] = cached
    }
    setImageSrcs(initial)
    setVideoSrcs({})
    for (const id of ids) {
      if (initial[id]) continue
      ensureTaskImageAvailable(id).then((url) => {
        if (!cancelled && url) setImageSrcs((prev) => ({ ...prev, [id]: url }))
      })
    }

    for (const videoId of task.outputVideos || []) {
      ensureTaskVideoAvailable(videoId).then((url) => {
        if (!cancelled && url) setVideoSrcs((prev) => ({ ...prev, [videoId]: url }))
      })

      const remoteUrl = task.mediaUrlsById?.[videoId] || task.imageUrlsById?.[videoId]
      if (remoteUrl) {
        void cacheTaskVideoForPlayback(videoId, remoteUrl).then((url) => {
          if (!cancelled && url) setVideoSrcs((prev) => ({ ...prev, [videoId]: url }))
        })
      }
    }

    return () => {
      cancelled = true
    }
  }, [task])

  const outputImageCount = task?.outputImages?.length ?? 0
  const currentOutputImageId = task?.outputImages?.[imageIndex] || ''
  const currentOutputImageBytes = currentOutputImageId ? task?.imageBytesById?.[currentOutputImageId] ?? null : null
  const currentOutputImageSrc = currentOutputImageId ? resolveTaskImageSrc(currentOutputImageId, imageSrcs, task) : ''

  useEffect(() => {
    if (outputImageCount === 0) return
    setImageIndex((current) => (current >= outputImageCount ? outputImageCount - 1 : current))
  }, [outputImageCount])
  const currentOutputVideoId = task?.outputVideos?.[0] || ''
  const currentOutputVideoRemoteSrc = currentOutputVideoId
    ? task?.mediaUrlsById?.[currentOutputVideoId] || task?.imageUrlsById?.[currentOutputVideoId] || ''
    : ''
  const currentOutputVideoSrc = currentOutputVideoId
    ? useNativeVideoControls
      ? currentOutputVideoRemoteSrc || videoSrcs[currentOutputVideoId] || ''
      : videoSrcs[currentOutputVideoId] || currentOutputVideoRemoteSrc || ''
    : ''
  const currentOutputVideoPoster = currentOutputVideoId
    ? imageSrcs[currentOutputVideoId] || task?.videoPosterUrlsById?.[currentOutputVideoId] || ''
    : ''
  const maskTargetId = task?.maskTargetImageId || null
  const maskTargetSrc = maskTargetId ? imageSrcs[maskTargetId] || '' : ''
  const maskSrc = task?.maskImageId ? imageSrcs[task.maskImageId] || '' : ''
  const allInputImageIds = task?.inputImageIds ?? []

  const handleActiveImageReady = useCallback((imageId: string, image: HTMLImageElement) => {
    if (imageId !== currentOutputImageId) return
    const panel = imagePanelRef.current
    if (!panel) return

    const panelRect = panel.getBoundingClientRect()
    const imageRect = image.getBoundingClientRect()
    setImageLabelLeft(Math.max(8, imageRect.left - panelRect.left))

    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setImageRatios((prev) => ({
        ...prev,
        [imageId]: formatImageRatio(image.naturalWidth, image.naturalHeight),
      }))
      setImageSizes((prev) => ({
        ...prev,
        [imageId]: `${image.naturalWidth}×${image.naturalHeight}`,
      }))
    }
  }, [currentOutputImageId])

  useEffect(() => {
    const updateImageLabelLeft = () => {
      const panel = imagePanelRef.current
      if (!panel) return
      setImageLabelLeft(8)
    }

    updateImageLabelLeft()
    window.addEventListener('resize', updateImageLabelLeft)
    return () => window.removeEventListener('resize', updateImageLabelLeft)
  }, [imageIndex, currentOutputImageSrc])

  useEffect(() => {
    let cancelled = false
    setMaskPreviewSrc('')
    if (!maskTargetSrc || !maskSrc) return

    createMaskPreviewDataUrl(maskTargetSrc, maskSrc)
      .then((url) => {
        if (!cancelled) setMaskPreviewSrc(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewSrc('')
      })

    return () => {
      cancelled = true
    }
  }, [maskTargetSrc, maskSrc])

  if (!task) return null

  const outputLen = outputImageCount
  const isVideoTask = task.taskType === 'video'
  const videoParams = isVideoTask ? task.params as VideoTaskParams : null
  const currentImageRatio = currentOutputImageId ? imageRatios[currentOutputImageId] : ''
  const currentImageSize = currentOutputImageId ? imageSizes[currentOutputImageId] : ''
  const currentActualParams = currentOutputImageId ? task.actualParamsByImage?.[currentOutputImageId] : undefined
  const currentRevisedPrompt = currentOutputImageId ? task.revisedPromptByImage?.[currentOutputImageId]?.trim() : ''
  const showRevisedPrompt = Boolean(currentRevisedPrompt && currentRevisedPrompt !== task.prompt.trim())
  const codexCliPromptKey = getCodexCliPromptKey(settings)
  const hasHandledPromptWarning = settings.codexCli || dismissedCodexCliPrompts.includes(codexCliPromptKey)
  const showPromptWarning = Boolean(currentOutputImageId && (!currentRevisedPrompt || showRevisedPrompt) && !hasHandledPromptWarning)
  const aggregateActualParams = outputLen > 0 ? { ...task.actualParams, n: outputLen } : task.actualParams
  const hasOutputImages = !isVideoTask && outputLen > 0
  const hasOutputVideo = isVideoTask && Boolean(task.outputVideos?.length)
  const hasRenderedOutput = isVideoTask ? Boolean(currentOutputVideoSrc) || hasOutputVideo : hasOutputImages
  const isTaskBlurred = (isVideoTask ? Boolean(currentOutputVideoSrc) : hasOutputImages) && (taskImageBlurOverrides[task.id] ?? blurLoadedImages)
  const runningStepText = task.serverStatus === 'queued'
    ? (task.queuePosition && task.queuePosition > 0 ? `排队中，前方还有 ${task.queueAhead ?? Math.max(task.queuePosition - 1, 0)} 个任务` : '排队中')
    : (task.currentStep || '正在继续生成剩余图片')

  const formatTime = (ts: number | null) => {
    if (!ts) return ''
    return new Date(ts).toLocaleString('zh-CN')
  }

  const formatDuration = () => {
    if (task.status === 'running') {
      const seconds = Math.max(0, Math.floor((now - task.createdAt) / 1000))
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
      const ss = String(seconds % 60).padStart(2, '0')
      return `${mm}:${ss}`
    }
    if (task.elapsed == null) return null
    const seconds = Math.floor(task.elapsed / 1000)
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  const handleReuse = () => {
    reuseConfig(task)
    setDetailTaskId(null)
  }

  const handleQuickEditOutput = () => {
    if (!currentOutputImageId) return
    setDetailTaskId(null)
    setLightboxStartEditor(true)
    setLightboxImageId(currentOutputImageId, task.outputImages)
  }

  const handleMaskEditCurrentOutput = () => {
    const imgId = task.outputImages?.[imageIndex]
    if (!imgId) return
    setMaskEditorImageId(imgId)
    setDetailTaskId(null)
  }

  const stopThumbnailGesture = (event: SyntheticEvent) => {
    event.stopPropagation()
  }

  const handleDelete = () => {
    setDetailTaskId(null)
    setConfirmDialog({
      title: '删除记录',
      message: '确定要删除这条记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => removeTask(task),
    })
  }

  const handleToggleFavorite = () => {
    updateTaskInStore(task.id, { isFavorite: !task.isFavorite })
  }

  const handleToggleArchived = () => {
    updateTaskInStore(task.id, { isArchived: !task.isArchived })
    if (!task.isArchived) {
      setDetailTaskId(null)
    }
  }

  const handleCopyError = async () => {
    const errorText = task.error || '生成失败'
    try {
      await copyTextToClipboard(errorText)
      showToast('完整报错已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制报错失败', err), 'error')
    }
  }

  const handleCopyPrompt = async () => {
    if (!task.prompt) return
    try {
      await copyTextToClipboard(task.prompt)
      showToast('提示词已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制提示词失败', err), 'error')
    }
  }

  const handleShowPromptWarning = () => {
    showCodexCliPrompt(
      true,
      currentRevisedPrompt ? '接口返回的提示词已被改写' : '接口没有返回官方 API 会返回的部分信息',
    )
  }

  const handleCopyTaskId = async () => {
    try {
      await copyTextToClipboard(task.id)
      showToast('任务号已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制任务号失败', err), 'error')
    }
  }

  const handleCopyInputImage = async () => {
    const imgId = allInputImageIds[0]
    const src = imgId ? imageSrcs[imgId] : ''
    if (!src) return
    try {
      const res = await fetch(src)
      const blob = await res.blob()
      await copyBlobToClipboard(blob)
      showToast('参考图已复制', 'success')
    } catch (err) {
      console.error(err)
      showToast(getClipboardFailureMessage('复制参考图失败', err), 'error')
    }
  }

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-50 flex items-end justify-center p-1 md:items-center md:p-4"
      onClick={() => setDetailTaskId(null)}
    >
      <div className="glass-overlay absolute inset-0 animate-overlay-in" />
      <div
        className="detail-modal-panel glass-surface-strong relative flex h-[min(96dvh,100%)] max-h-[96dvh] w-full max-w-4xl flex-col overflow-y-auto overscroll-contain rounded-3xl border border-white/50 shadow-[0_8px_40px_rgb(0,0,0,0.12)] ring-1 ring-black/5 dark:border-white/[0.08] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] dark:ring-white/10 animate-modal-in md:h-auto md:max-h-[90vh] md:flex-row md:overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧：图片 */}
        <div
          ref={imagePanelRef}
          className="detail-modal-image-panel relative flex w-full flex-shrink-0 items-center justify-center bg-gray-100 dark:bg-black/20 min-h-[70dvh] md:h-auto md:min-h-[16rem] md:w-1/2 md:flex-none"
          style={{ touchAction: 'pan-y' }}
        >
          {hasRenderedOutput && (
            <>
              {isVideoTask ? (
                <VideoPlayer
                  src={currentOutputVideoSrc}
                  poster={currentOutputVideoPoster || undefined}
                  nativeControls={false}
                  blurred={isTaskBlurred}
                />
              ) : (
                <div className="absolute inset-0">
                  <DetailOutputImageCarousel
                    ref={carouselRef}
                    task={task}
                    imageSrcs={imageSrcs}
                    imageIndex={imageIndex}
                    onImageIndexChange={setImageIndex}
                    isTaskBlurred={isTaskBlurred}
                    onActiveImageReady={handleActiveImageReady}
                    onOpenLightbox={(imageId) => setLightboxImageId(imageId, task.outputImages)}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => setDetailTaskId(null)}
                className="absolute right-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-white/30 bg-black/45 text-white/90 backdrop-blur transition hover:bg-black/60 md:hidden"
                aria-label="关闭"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => toggleTaskImageBlur(task.id)}
                className={`absolute top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition md:right-4 md:top-4 ${
                  isTaskBlurred
                    ? 'right-14 border-blue-300/70 bg-blue-500/80 text-white'
                    : 'right-14 border-white/30 bg-black/40 text-white/80 hover:bg-black/55 md:right-4'
                }`}
                title={isTaskBlurred ? '解除当前任务模糊' : '模糊当前任务'}
              >
                {isTaskBlurred ? (
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
              <div className="absolute top-[15px] flex items-center gap-1.5" style={{ left: imageLabelLeft }}>
                {isVideoTask ? (
                  <span className="bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                    {videoParams?.aspect_ratio ?? 'auto'}
                  </span>
                ) : currentImageRatio && currentImageSize ? (
                  <>
                    <span className="bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                      {currentImageRatio}
                    </span>
                    <span className="bg-black/50 text-white/90 text-xs px-2 py-0.5 rounded backdrop-blur-sm font-medium">
                      {currentImageSize}
                    </span>
                  </>
                ) : (
                  formatDuration() && (
                    <span className="flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {formatDuration()}
                    </span>
                  )
                )}
              </div>
              {!isVideoTask && outputLen > 1 && (
                <>
                  <button
                    type="button"
                    data-no-carousel-swipe
                    onClick={() => carouselRef.current?.animatePrev()}
                    className="absolute left-1.5 top-1/2 z-20 -translate-y-1/2 rounded-full bg-black/45 p-1.5 text-white backdrop-blur-sm transition hover:bg-black/60 sm:left-2"
                    aria-label="上一张"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    data-no-carousel-swipe
                    onClick={() => carouselRef.current?.animateNext()}
                    className="absolute right-1.5 top-1/2 z-20 -translate-y-1/2 rounded-full bg-black/45 p-1.5 text-white backdrop-blur-sm transition hover:bg-black/60 sm:right-2"
                    aria-label="下一张"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  <div
                    className="absolute bottom-1.5 left-1/2 z-10 flex max-w-[min(88%,26rem)] -translate-x-1/2 flex-col items-center gap-0.5 rounded-xl bg-black/50 px-1.5 py-1 text-white shadow-lg backdrop-blur-sm sm:bottom-2 sm:max-w-[min(70%,28rem)] sm:gap-1 sm:rounded-2xl sm:px-2 sm:py-1.5"
                    onClick={stopThumbnailGesture}
                    onMouseDown={stopThumbnailGesture}
                    onTouchStart={stopThumbnailGesture}
                    onTouchMove={stopThumbnailGesture}
                    onTouchEnd={stopThumbnailGesture}
                    style={{ touchAction: 'pan-x' }}
                  >
                    <div className="mask-edge-x tiny-scrollbar flex max-w-[10rem] gap-1 overflow-x-auto px-2 py-0.5 sm:max-w-[16rem] md:max-w-[18rem]">
                      {task.outputImages.map((imgId, index) => {
                        const src = resolveTaskImageSrc(imgId, imageSrcs, task)
                        return (
                          <button
                            key={imgId}
                            type="button"
                            onClick={() => setImageIndex(index)}
                            className={`h-7 w-7 shrink-0 overflow-hidden rounded-md border transition sm:h-9 sm:w-9 ${
                              index === imageIndex
                                ? 'border-blue-400 ring-2 ring-blue-400/80'
                                : 'border-white/30 opacity-70 hover:opacity-100'
                            }`}
                            aria-label={`查看第 ${index + 1} 张图片`}
                          >
                            {src ? (
                              <img
                                src={src}
                                className={`h-full w-full object-cover transition duration-200 ${isTaskBlurred ? 'scale-[1.02] blur-md' : ''}`}
                                alt=""
                                draggable={false}
                              />
                            ) : (
                              <span className="flex h-full w-full items-center justify-center bg-white/10 text-[10px] text-white/60">
                                {index + 1}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                    <span className="shrink-0 text-xs font-medium leading-none tabular-nums text-white/90">
                      {imageIndex + 1} / {outputLen}
                    </span>
                  </div>
                </>
              )}
            </>
          )}
          {task.status === 'running' && !hasRenderedOutput && (
            <>
              <div className="absolute left-4 top-4 flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {formatDuration()}
              </div>
              <svg className="w-10 h-10 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </>
          )}
          {task.status === 'error' && !hasRenderedOutput && (
            <div className="w-full max-w-md px-4 text-center">
              <svg className="w-10 h-10 text-red-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p
                className="overflow-hidden text-sm leading-6 text-red-500 break-all"
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 4,
                }}
              >
                {task.error || '生成失败'}
              </p>
              <button
                type="button"
                onClick={handleCopyError}
                className="mt-3 inline-flex items-center justify-center rounded-full border border-red-200/80 bg-white/80 px-3 py-1.5 text-red-500 transition hover:bg-red-50 dark:border-red-400/20 dark:bg-white/[0.04] dark:hover:bg-red-500/10"
                aria-label="复制完整报错"
                title="复制完整报错"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
              </button>
            </div>
          )}
          {task.status === 'running' && hasRenderedOutput && (
            <div className="absolute bottom-3 left-3">
              <span className="inline-flex rounded-full bg-black/55 px-3 py-1.5 text-xs text-white/90 backdrop-blur-sm">
                {runningStepText}
              </span>
            </div>
          )}
        </div>

        {/* 右侧：信息 */}
        <div className="detail-modal-info-panel flex w-full flex-shrink-0 flex-col border-t border-gray-200/70 p-4 tiny-scrollbar dark:border-white/[0.08] md:min-h-0 md:w-1/2 md:flex-1 md:basis-0 md:flex-none md:overflow-y-auto md:overscroll-contain md:border-t-0 md:p-5">
          <button
            onClick={() => setDetailTaskId(null)}
            className="absolute top-3 right-3 hidden p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06] transition text-gray-400 z-10 md:block"
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <div className="flex-1">
            <div className="flex items-center gap-1.5 mb-2">
              <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                输入内容
              </h3>
              {task.prompt && (
                <button
                  onClick={handleCopyPrompt}
                  className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-white/[0.06] transition"
                  title="复制提示词"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              )}
              {showPromptWarning && (
                <span className="relative inline-flex">
                  <button
                    type="button"
                    className="p-1 rounded text-amber-500 hover:bg-amber-50 dark:text-yellow-300 dark:hover:bg-yellow-500/10 transition"
                    onClick={handleShowPromptWarning}
                    aria-label="提示词已被改写"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    </svg>
                  </button>
                </span>
              )}
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap mb-4">
              {task.prompt || '(无提示词)'}
            </p>
            {showRevisedPrompt && currentRevisedPrompt && (
              <div className="mb-4">
                <ActualValueBadge
                  value={currentRevisedPrompt}
                  className="max-w-full rounded px-2 py-1 text-left text-xs leading-relaxed whitespace-pre-wrap"
                />
              </div>
            )}

            {/* 参考图 */}
            {allInputImageIds.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center gap-1.5 mb-2">
                  <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                    参考图
                  </h3>
                  <button
                    onClick={handleCopyInputImage}
                    className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-white/[0.06] transition"
                    title="复制参考图"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {allInputImageIds.map((imgId) => {
                    const isMaskTarget = imgId === maskTargetId
                    const displaySrc = (isMaskTarget && maskPreviewSrc) ? maskPreviewSrc : (imageSrcs[imgId] || '')
                    return (
                      <div key={imgId} className="relative group inline-block">
                        <div
                          className={`relative w-16 h-16 rounded-lg overflow-hidden border cursor-pointer hover:opacity-80 transition ${
                            isMaskTarget ? 'border-blue-500 border-2 shadow-sm' : 'border-gray-200 dark:border-white/[0.08]'
                          }`}
                          onClick={() => setLightboxImageId(imgId, allInputImageIds)}
                        >
                          <img
                            src={displaySrc}
                            data-image-id={imgId}
                            data-original-src={task.imageUrlsById?.[imgId]}
                            className={`w-full h-full object-cover transition duration-200 ${isTaskBlurred ? 'scale-[1.02] blur-md' : ''}`}
                            onLoad={(event) => {
                              const remoteUrl = task.imageUrlsById?.[imgId]
                              if (!remoteUrl) return
                              void cacheTaskImageForEditing(imgId, remoteUrl, event.currentTarget)
                            }}
                            alt=""
                          />
                          {isMaskTarget && (
                            <span className="absolute left-1 top-1 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] leading-none text-white font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
                              MASK
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* 参数 */}
            <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
              参数配置
            </h3>
            <div className="grid grid-cols-2 gap-2 text-xs mb-4">
              {isVideoTask ? (
                <>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">类型</span>
                    <br />
                    <span className="font-medium">视频</span>
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">比例</span>
                    <br />
                    <span className="font-medium">{videoParams?.aspect_ratio ?? 'auto'}</span>
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">分辨率</span>
                    <br />
                    <span className="font-medium">{videoParams?.resolution ?? '480p'}</span>
                  </div>
                  <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                    <span className="text-gray-400 dark:text-gray-500">时长</span>
                    <br />
                    <span className="font-medium">{videoParams?.duration ?? 6}s</span>
                  </div>
                </>
              ) : (
                <>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                <span className="text-gray-400 dark:text-gray-500">尺寸</span>
                <br />
                <DetailParamValue task={task} paramKey="size" className="font-medium" actualParams={currentActualParams} />
              </div>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                <span className="text-gray-400 dark:text-gray-500">质量</span>
                <br />
                <DetailParamValue task={task} paramKey="quality" className="font-medium" actualParams={currentActualParams} />
              </div>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                <span className="text-gray-400 dark:text-gray-500">格式</span>
                <br />
                <DetailParamValue task={task} paramKey="output_format" className="font-medium" actualParams={currentActualParams} />
              </div>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                <span className="text-gray-400 dark:text-gray-500">审核</span>
                <br />
                <DetailParamValue task={task} paramKey="moderation" className="font-medium" actualParams={currentActualParams} />
              </div>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                <span className="text-gray-400 dark:text-gray-500">数量</span>
                <br />
                <DetailParamValue task={task} paramKey="n" className="font-medium" actualParams={aggregateActualParams} />
              </div>
              {task.providerProfileName && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                  <span className="text-gray-400 dark:text-gray-500">API 配置</span>
                  <br />
                  <span className="font-medium break-all">{task.providerProfileName}</span>
                </div>
              )}
              {!isVideoTask && currentOutputImageBytes != null && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                  <span className="text-gray-400 dark:text-gray-500">图片大小</span>
                  <br />
                  <span className="font-medium break-all">{formatBytes(currentOutputImageBytes)}</span>
                </div>
              )}
              {task.providerProfileModel && !isUsageCodeUser && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                  <span className="text-gray-400 dark:text-gray-500">模型</span>
                  <br />
                  <span className="font-medium break-all">{task.providerProfileModel}</span>
                </div>
              )}
              {(task.params as { output_compression?: number | null }).output_compression != null && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2">
                  <span className="text-gray-400 dark:text-gray-500">压缩率</span>
                  <br />
                  <DetailParamValue task={task} paramKey="output_compression" className="font-medium" actualParams={currentActualParams} />
                </div>
              )}
                </>
              )}
            </div>

            {/* 时间 */}
            <div className="mb-4 text-xs text-gray-400 dark:text-gray-500">
              <div ref={taskIdPopoverRef} className="relative inline-flex items-center gap-0">
                <button
                  type="button"
                  onClick={() => setIsTaskIdPopoverOpen((prev) => !prev)}
                  className="rounded-md transition hover:text-gray-600 dark:hover:text-gray-300"
                >
                  创建于 {formatTime(task.createdAt)}
                </button>
                {isTaskIdPopoverOpen && (
                  <div className="absolute left-0 top-full z-20 mt-2 w-[min(22rem,calc(100vw-4rem))] rounded-2xl border border-gray-200/70 bg-white/95 p-3 text-left shadow-[0_12px_36px_rgb(0,0,0,0.14)] ring-1 ring-black/5 backdrop-blur dark:border-white/[0.08] dark:bg-[#1d1d1f]/95 dark:ring-white/10">
                    <div className="text-[11px] text-gray-400 dark:text-gray-500">任务号</div>
                    <div className="mt-1 break-all text-xs text-gray-700 dark:text-gray-200">{task.id}</div>
                    <button
                      type="button"
                      onClick={handleCopyTaskId}
                      className="mt-3 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-600 transition hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20"
                    >
                      复制任务号
                    </button>
                  </div>
                )}
              </div>
              {formatDuration() && <span> · 耗时 {formatDuration()}</span>}
              {task.ownerLabel && <span> · 来源 </span>}
              {task.ownerLabel && <UsageCodeBadge task={task} />}
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="grid grid-cols-2 gap-2 pt-4 border-t border-gray-100 dark:border-white/[0.08]">
            <button
              onClick={handleReuse}
              className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-blue-50 px-3 py-2 text-sm font-medium text-blue-600 transition hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-400 dark:hover:bg-blue-500/20"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              复用配置
            </button>
            <button
              onClick={handleMaskEditCurrentOutput}
              disabled={!outputLen || isVideoTask}
              className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-blue-50 px-3 py-2 text-sm font-medium text-blue-600 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-500/10 dark:text-blue-400 dark:hover:bg-blue-500/20"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M4 20h4.586a1 1 0 00.707-.293l10.414-10.414a2 2 0 000-2.828l-2.172-2.172a2 2 0 00-2.828 0L4.293 14.707A1 1 0 004 15.414V20z" />
              </svg>
              遮罩编辑
            </button>
            <button
              onClick={handleQuickEditOutput}
              disabled={!outputLen || isVideoTask}
              className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-green-50 px-3 py-2 text-sm font-medium text-green-600 transition hover:bg-green-100 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-green-500/10 dark:text-green-400 dark:hover:bg-green-500/20"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              高级编辑
            </button>
            {isVideoTask && currentOutputVideoSrc && (
              <a
                href={currentOutputVideoSrc}
                download={`${task.id}.mp4`}
                className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-green-50 px-3 py-2 text-sm font-medium text-green-600 transition hover:bg-green-100 dark:bg-green-500/10 dark:text-green-400 dark:hover:bg-green-500/20"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v11m0 0l4-4m-4 4l-4-4M4 17v1a2 2 0 002 2h12a2 2 0 002-2v-1" />
                </svg>
                下载视频
              </a>
            )}
            <button
              onClick={handleDelete}
              className="flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              删除记录
            </button>
            <button
              onClick={handleToggleFavorite}
              className={`flex min-h-10 w-full items-center justify-center rounded-xl transition ${
                task.isFavorite
                  ? 'bg-yellow-50 text-yellow-500 hover:bg-yellow-100 dark:bg-yellow-500/10 dark:hover:bg-yellow-500/20'
                  : 'bg-gray-50 text-gray-400 hover:bg-yellow-50 hover:text-yellow-500 dark:bg-white/[0.04] dark:hover:bg-yellow-500/10'
              }`}
              title={task.isFavorite ? '取消收藏' : '收藏记录'}
            >
              <svg className="w-5 h-5" fill={task.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
            </button>
            <button
              onClick={handleToggleArchived}
              className={`flex min-h-10 w-full items-center justify-center rounded-xl transition ${
                task.isArchived
                  ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/[0.08] dark:text-slate-200 dark:hover:bg-white/[0.12]'
                  : 'bg-gray-50 text-gray-400 hover:bg-slate-100 hover:text-slate-600 dark:bg-white/[0.04] dark:hover:bg-white/[0.08]'
              }`}
              title={task.isArchived ? '取消归档' : '归档记录'}
            >
              <svg className="w-5 h-5" fill={task.isArchived ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <rect x="4" y="4" width="16" height="5" rx="1" />
                <path d="M6 9v10a1 1 0 001 1h10a1 1 0 001-1V9" />
                <path d="M10 13h4" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
