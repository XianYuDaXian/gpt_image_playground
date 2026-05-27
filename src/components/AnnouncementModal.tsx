import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackendReminderItem } from '../lib/backendSettings'
import { renderTextWithLinks } from '../lib/linkify'
import { preloadAnnouncementImages, useAnnouncementImageSources } from '../lib/announcementImageCache'

const MIN_SCALE = 1
const MAX_SCALE = 10

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function isPreviewControl(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-announcement-preview-control]'))
}

export default function AnnouncementModal({
  announcement,
  onClose,
}: {
  announcement: BackendReminderItem
  onClose: () => void
}) {
  const [showImagePreview, setShowImagePreview] = useState(false)
  const [imageIndex, setImageIndex] = useState(0)
  const imageDataUrls = announcement.imageDataUrls?.length
    ? announcement.imageDataUrls
    : announcement.imageDataUrl
      ? [announcement.imageDataUrl]
      : []
  const resolvedImageSources = useAnnouncementImageSources(imageDataUrls)
  const showNav = imageDataUrls.length > 1

  useEffect(() => {
    setImageIndex(0)
  }, [announcement.id])

  useEffect(() => {
    preloadAnnouncementImages(imageDataUrls)
  }, [imageDataUrls.join('\n')])

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
          {imageDataUrls.length > 0 && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => setShowImagePreview(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setShowImagePreview(true)
                }
              }}
              className="mb-4 block w-full overflow-hidden rounded-2xl bg-black/5 dark:bg-white/[0.04]"
            >
              <div className="relative min-h-[12rem]">
                {imageDataUrls.map((imageDataUrl, currentIndex) => (
                  <img
                    key={`${announcement.id}-image-${currentIndex}`}
                    src={resolvedImageSources[imageDataUrl] ?? imageDataUrl}
                    alt={announcement.title || '公告配图'}
                    className={`max-h-80 w-full select-none object-contain ${currentIndex === imageIndex ? 'block' : 'hidden'}`}
                    draggable={false}
                  />
                ))}
                {showNav && (
                  <>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setImageIndex((current) => (current - 1 + imageDataUrls.length) % imageDataUrls.length)
                      }}
                      className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/35 p-2 text-white transition hover:bg-black/55"
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setImageIndex((current) => (current + 1) % imageDataUrls.length)
                      }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/35 p-2 text-white transition hover:bg-black/55"
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                    <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 rounded-2xl bg-black/50 px-2 py-1.5 text-white shadow-lg backdrop-blur-sm">
                      <div className="mask-edge-x tiny-scrollbar flex max-w-[12rem] gap-1 overflow-x-auto px-2 py-0.5 sm:max-w-[16rem]">
                        {imageDataUrls.map((imageDataUrl, currentIndex) => (
                          <button
                            key={`${announcement.id}-thumb-${currentIndex}`}
                            type="button"
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              setImageIndex(currentIndex)
                            }}
                            className={`h-9 w-9 shrink-0 overflow-hidden rounded-md border transition ${
                              currentIndex === imageIndex
                                ? 'border-blue-400 ring-2 ring-blue-400/80'
                                : 'border-white/30 opacity-70 hover:opacity-100'
                            }`}
                          >
                            <img
                              src={resolvedImageSources[imageDataUrl] ?? imageDataUrl}
                              alt=""
                              className="h-full w-full select-none object-cover"
                              draggable={false}
                            />
                          </button>
                        ))}
                      </div>
                      <span className="text-xs font-medium leading-none text-white/90">
                        {imageIndex + 1} / {imageDataUrls.length}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="whitespace-pre-wrap break-words text-sm leading-7 text-gray-700 dark:text-gray-200">
            {renderTextWithLinks(announcement.message)}
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
      {showImagePreview && imageDataUrls.length > 0 && (
        <AnnouncementImagePreview
          announcementId={announcement.id}
          title={announcement.title || '公告配图'}
          imageDataUrls={imageDataUrls}
          resolvedImageSources={resolvedImageSources}
          imageIndex={imageIndex}
          onChangeImageIndex={setImageIndex}
          onClose={() => setShowImagePreview(false)}
        />
      )}
    </div>
  )
}

function AnnouncementImagePreview({
  announcementId,
  title,
  imageDataUrls,
  resolvedImageSources,
  imageIndex,
  onChangeImageIndex,
  onClose,
}: {
  announcementId: string
  title: string
  imageDataUrls: string[]
  resolvedImageSources: Record<string, string>
  imageIndex: number
  onChangeImageIndex: (value: number | ((current: number) => number)) => void
  onClose: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(1)
  const txRef = useRef(0)
  const tyRef = useRef(0)
  const [, forceRender] = useState(0)
  const [showZoomBadge, setShowZoomBadge] = useState(false)
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    baseTx: 0,
    baseTy: 0,
  })
  const pinchRef = useRef({
    active: false,
    startDist: 0,
    startScale: 1,
    startTx: 0,
    startTy: 0,
    midX: 0,
    midY: 0,
  })
  const tapRef = useRef({ time: 0, x: 0, y: 0 })
  const hadMultiTouchRef = useRef(false)
  const touchStartedOnImageRef = useRef(false)
  const didDragRef = useRef(false)
  const showNav = imageDataUrls.length > 1

  const rerender = useCallback(() => forceRender((value) => value + 1), [])

  const getCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return { cx: 0, cy: 0 }
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 }
  }, [])

  const apply = useCallback((scale: number, tx: number, ty: number) => {
    const nextScale = clamp(scale, MIN_SCALE, MAX_SCALE)
    scaleRef.current = nextScale
    txRef.current = nextScale <= 1 ? 0 : tx
    tyRef.current = nextScale <= 1 ? 0 : ty

    if (nextScale > 1) {
      setShowZoomBadge(true)
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
      zoomTimerRef.current = setTimeout(() => setShowZoomBadge(false), 1500)
    } else {
      setShowZoomBadge(false)
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
    }

    rerender()
  }, [rerender])

  useEffect(() => {
    scaleRef.current = 1
    txRef.current = 0
    tyRef.current = 0
    dragRef.current.active = false
    pinchRef.current.active = false
    didDragRef.current = false
    touchStartedOnImageRef.current = false
    hadMultiTouchRef.current = false
    tapRef.current = { time: 0, x: 0, y: 0 }
    setShowZoomBadge(false)
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
    rerender()
  }, [announcementId, imageIndex, rerender])

  useEffect(() => {
    return () => {
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const offsetX = event.clientX - rect.left - rect.width / 2
      const offsetY = event.clientY - rect.top - rect.height / 2
      const currentScale = scaleRef.current
      const currentTx = txRef.current
      const currentTy = tyRef.current
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
      const nextScale = clamp(currentScale * factor, MIN_SCALE, MAX_SCALE)
      const ratio = nextScale / currentScale
      apply(nextScale, offsetX - ratio * (offsetX - currentTx), offsetY - ratio * (offsetY - currentTy))
    }

    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [apply])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return
      didDragRef.current = false
      if (scaleRef.current <= 1) return
      event.preventDefault()
      dragRef.current = {
        active: true,
        startX: event.clientX,
        startY: event.clientY,
        baseTx: txRef.current,
        baseTy: tyRef.current,
      }
    }

    const handleMouseMove = (event: MouseEvent) => {
      if (!dragRef.current.active) return
      const deltaX = event.clientX - dragRef.current.startX
      const deltaY = event.clientY - dragRef.current.startY
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) didDragRef.current = true
      apply(scaleRef.current, dragRef.current.baseTx + deltaX, dragRef.current.baseTy + deltaY)
    }

    const handleMouseUp = () => {
      dragRef.current.active = false
    }

    element.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      element.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [apply])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const handleTouchStart = (event: TouchEvent) => {
      if (isPreviewControl(event.target)) {
        tapRef.current = { time: 0, x: 0, y: 0 }
        touchStartedOnImageRef.current = false
        return
      }

      if (event.touches.length === 2) {
        event.preventDefault()
        hadMultiTouchRef.current = true
        tapRef.current = { time: 0, x: 0, y: 0 }
        const [firstTouch, secondTouch] = [event.touches[0], event.touches[1]]
        const distance = Math.hypot(firstTouch.clientX - secondTouch.clientX, firstTouch.clientY - secondTouch.clientY)
        const { cx, cy } = getCenter()
        pinchRef.current = {
          active: true,
          startDist: distance,
          startScale: scaleRef.current,
          startTx: txRef.current,
          startTy: tyRef.current,
          midX: (firstTouch.clientX + secondTouch.clientX) / 2 - cx,
          midY: (firstTouch.clientY + secondTouch.clientY) / 2 - cy,
        }
        dragRef.current.active = false
        return
      }

      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      const now = Date.now()
      const previousTap = tapRef.current
      touchStartedOnImageRef.current = event.target instanceof HTMLImageElement

      if (
        now - previousTap.time < 300 &&
        Math.abs(touch.clientX - previousTap.x) < 30 &&
        Math.abs(touch.clientY - previousTap.y) < 30
      ) {
        event.preventDefault()
        if (scaleRef.current > 1) {
          apply(1, 0, 0)
        } else {
          const { cx, cy } = getCenter()
          const offsetX = touch.clientX - cx
          const offsetY = touch.clientY - cy
          apply(3, -offsetX * 2, -offsetY * 2)
        }
        tapRef.current = { time: 0, x: 0, y: 0 }
        return
      }

      tapRef.current = { time: now, x: touch.clientX, y: touch.clientY }

      if (scaleRef.current > 1 && touchStartedOnImageRef.current) {
        event.preventDefault()
        dragRef.current = {
          active: true,
          startX: touch.clientX,
          startY: touch.clientY,
          baseTx: txRef.current,
          baseTy: tyRef.current,
        }
      }
    }

    const handleTouchMove = (event: TouchEvent) => {
      if (pinchRef.current.active && event.touches.length === 2) {
        event.preventDefault()
        const [firstTouch, secondTouch] = [event.touches[0], event.touches[1]]
        const distance = Math.hypot(firstTouch.clientX - secondTouch.clientX, firstTouch.clientY - secondTouch.clientY)
        const currentPinch = pinchRef.current
        const nextScale = clamp(currentPinch.startScale * (distance / currentPinch.startDist), MIN_SCALE, MAX_SCALE)
        const ratio = nextScale / currentPinch.startScale
        apply(
          nextScale,
          currentPinch.midX - ratio * (currentPinch.midX - currentPinch.startTx),
          currentPinch.midY - ratio * (currentPinch.midY - currentPinch.startTy),
        )
        return
      }

      if (!dragRef.current.active || event.touches.length !== 1) return
      event.preventDefault()
      const touch = event.touches[0]
      apply(
        scaleRef.current,
        dragRef.current.baseTx + touch.clientX - dragRef.current.startX,
        dragRef.current.baseTy + touch.clientY - dragRef.current.startY,
      )
    }

    const handleTouchEnd = (event: TouchEvent) => {
      if (isPreviewControl(event.target)) {
        tapRef.current = { time: 0, x: 0, y: 0 }
        return
      }

      if (event.touches.length < 2) pinchRef.current.active = false
      if (event.touches.length !== 0) return

      dragRef.current.active = false
      if (hadMultiTouchRef.current) {
        hadMultiTouchRef.current = false
        tapRef.current = { time: 0, x: 0, y: 0 }
        return
      }

      if (scaleRef.current <= 1 || !touchStartedOnImageRef.current) {
        const previousTap = tapRef.current
        if (previousTap.time > 0 && Date.now() - previousTap.time < 300) {
          window.setTimeout(() => {
            if (tapRef.current.time === previousTap.time) {
              onClose()
            }
          }, 310)
        }
      }
    }

    element.addEventListener('touchstart', handleTouchStart, { passive: false })
    element.addEventListener('touchmove', handleTouchMove, { passive: false })
    element.addEventListener('touchend', handleTouchEnd)
    return () => {
      element.removeEventListener('touchstart', handleTouchStart)
      element.removeEventListener('touchmove', handleTouchMove)
      element.removeEventListener('touchend', handleTouchEnd)
    }
  }, [apply, getCenter, onClose])

  const handlePreviewClick = useCallback((event: React.MouseEvent) => {
    if (isPreviewControl(event.target)) return
    if (didDragRef.current) return
    if (scaleRef.current > 1 && event.target instanceof HTMLImageElement) return
    onClose()
  }, [onClose])

  const handlePreviewDoubleClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation()
    if (scaleRef.current > 1) {
      apply(1, 0, 0)
      return
    }
    const { cx, cy } = getCenter()
    const offsetX = event.clientX - cx
    const offsetY = event.clientY - cy
    apply(3, -offsetX * 2, -offsetY * 2)
  }, [apply, getCenter])

  const scale = scaleRef.current
  const translateX = txRef.current
  const translateY = tyRef.current
  const isZoomed = scale > 1
  const isDragging = dragRef.current.active || pinchRef.current.active
  const zoomPercent = Math.round(scale * 100)

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[76] flex items-center justify-center select-none"
      style={{
        cursor: isZoomed ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
        touchAction: 'none',
      }}
      onMouseDownCapture={(event) => {
        if (isPreviewControl(event.target)) return
        event.preventDefault()
      }}
      onClick={handlePreviewClick}
      onDoubleClick={handlePreviewDoubleClick}
    >
      <div className="absolute inset-0 bg-black/80" />
      <button
        type="button"
        data-announcement-preview-control
        onClick={onClose}
        className="absolute right-5 top-5 z-20 rounded-full bg-black/40 p-2 text-white transition hover:bg-black/60"
        aria-label="关闭图片预览"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      <div className="relative animate-zoom-in">
        <div
          className="relative flex items-center justify-center"
          style={{
            transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
            transition: isDragging ? 'none' : 'transform 0.2s ease-out',
            willChange: 'transform',
          }}
        >
          {imageDataUrls.map((imageDataUrl, currentIndex) => (
            <img
              key={`${announcementId}-preview-image-${currentIndex}`}
              src={resolvedImageSources[imageDataUrl] ?? imageDataUrl}
              alt={title}
              className={`max-h-[85vh] max-w-[85vw] select-none rounded-lg object-contain shadow-2xl ${currentIndex === imageIndex ? 'block' : 'hidden'}`}
              onDragStart={(event) => event.preventDefault()}
              draggable={false}
              style={{
                userSelect: 'none',
                WebkitUserSelect: 'none',
              }}
            />
          ))}
        </div>
      </div>

      {showNav && !isZoomed && (
        <>
          <button
            type="button"
            data-announcement-preview-control
            onClick={() => onChangeImageIndex((current) => (current - 1 + imageDataUrls.length) % imageDataUrls.length)}
            className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white backdrop-blur-sm transition hover:bg-black/60 sm:left-5"
          >
            <svg className="h-5 w-5 sm:h-6 sm:w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            type="button"
            data-announcement-preview-control
            onClick={() => onChangeImageIndex((current) => (current + 1) % imageDataUrls.length)}
            className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white backdrop-blur-sm transition hover:bg-black/60 sm:right-5"
          >
            <svg className="h-5 w-5 sm:h-6 sm:w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div
            data-announcement-preview-control
            className="absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 rounded-2xl bg-black/50 px-2 py-1.5 text-white shadow-lg backdrop-blur-sm"
          >
            <div className="mask-edge-x tiny-scrollbar flex max-w-[12rem] gap-1 overflow-x-auto px-2 py-0.5 sm:max-w-[16rem]">
              {imageDataUrls.map((imageDataUrl, currentIndex) => (
                <button
                  key={`${announcementId}-preview-thumb-${currentIndex}`}
                  type="button"
                  data-announcement-preview-control
                  onClick={() => onChangeImageIndex(currentIndex)}
                  className={`h-9 w-9 shrink-0 overflow-hidden rounded-md border transition ${
                    currentIndex === imageIndex
                      ? 'border-blue-400 ring-2 ring-blue-400/80'
                      : 'border-white/30 opacity-70 hover:opacity-100'
                  }`}
                >
                  <img
                    src={resolvedImageSources[imageDataUrl] ?? imageDataUrl}
                    alt=""
                    className="h-full w-full select-none object-cover"
                    draggable={false}
                  />
                </button>
              ))}
            </div>
            <span className="text-xs font-medium leading-none text-white/90">
              {imageIndex + 1} / {imageDataUrls.length}
            </span>
          </div>
        </>
      )}

      {showZoomBadge && isZoomed && zoomPercent !== 100 && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2">
          <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs text-white/80 backdrop-blur-sm transition-opacity duration-500">
            {zoomPercent}%
          </span>
        </div>
      )}
    </div>
  )
}
