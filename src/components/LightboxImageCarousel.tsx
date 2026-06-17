import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { useStore, cacheTaskImageForEditing } from '../store'
import { useTrackedImageLoad } from '../hooks/useTrackedImageLoad'
import { resolveTaskImageDisplaySrc } from '../lib/resolveTaskImageDisplay'
import {
  CAROUSEL_SLIDE_EASING,
  CAROUSEL_SLIDE_TRANSITION_MS,
  isTouchTapLike,
  resolveTouchAxisLock,
  resolveTouchSwipeThreshold,
  commitCarouselPendingSlide,
  type ImageCarouselHandle,
  type TouchAxisLock,
} from '../lib/touchGesture'
import ImageLoadingOverlay from './ImageLoadingOverlay'

interface LightboxSlideProps {
  imageId: string
  isActive: boolean
  imageIndex: number
  imageTotal: number
  maskPreviewSrc?: string
}

function LightboxSlide({
  imageId,
  isActive,
  imageIndex,
  imageTotal,
  maskPreviewSrc,
}: LightboxSlideProps) {
  const tasks = useStore((s) => s.tasks)
  const matchedTask = tasks.find((item) =>
    item.inputImageIds.includes(imageId) ||
    item.outputImages.includes(imageId) ||
    item.maskImageId === imageId,
  ) ?? null
  const remoteSrc = matchedTask?.imageUrlsById?.[imageId] ?? ''
  const syncSrc = resolveTaskImageDisplaySrc(imageId, tasks)
  const loadSrc = remoteSrc || syncSrc
  const expectedBytes = matchedTask?.imageBytesById?.[imageId] ?? null

  const {
    displaySrc,
    isLoading,
    showLoadingOverlay,
    progress,
  } = useTrackedImageLoad(loadSrc, {
    imageId,
    expectedBytes,
    enabled: Boolean(imageId && loadSrc),
  })

  return (
    <div className="relative flex h-full w-full flex-shrink-0 items-center justify-center px-2 sm:px-4">
      <div className="relative inline-flex max-h-[90dvh] max-w-[min(92vw,100%)] items-center justify-center">
        {isActive && (showLoadingOverlay || (!displaySrc && isLoading)) && (
          <ImageLoadingOverlay
            progress={progress}
            imageIndex={imageIndex}
            imageTotal={imageTotal}
            variant="dark"
          />
        )}
        {displaySrc ? (
          <img
            src={displaySrc}
            data-image-id={imageId}
            data-lightbox-active={isActive ? 'true' : undefined}
            data-original-src={matchedTask?.imageUrlsById?.[imageId]}
            className={`saveable-image max-h-[90dvh] max-w-[min(92vw,100%)] object-contain rounded-lg shadow-2xl transition-opacity duration-200 ${
              showLoadingOverlay && isActive ? 'opacity-0' : 'opacity-100'
            }`}
            onLoad={(event) => {
              if (!isActive) return
              const remoteUrl = matchedTask?.imageUrlsById?.[imageId]
              if (!remoteUrl) return
              void cacheTaskImageForEditing(imageId, remoteUrl, event.currentTarget)
            }}

            onDragStart={(event) => event.preventDefault()}
            alt=""
            draggable={false}
          />
        ) : null}
        {isActive && maskPreviewSrc && !showLoadingOverlay && displaySrc ? (
          <img
            src={maskPreviewSrc}
            className="pointer-events-none absolute inset-0 m-auto max-h-[90dvh] max-w-[min(92vw,100%)] rounded-lg object-contain"
            alt=""
          />
        ) : null}
      </div>
    </div>
  )
}

export interface LightboxCarouselNavState {
  dragOffset: number
  isDragging: boolean
  panelWidth: number
}

interface LightboxImageCarouselProps {
  imageIds: string[]
  currentIndex: number
  maskPreviewSrc?: string
  zoomTransform: string
  zoomTransition: string
  swipeEnabled: boolean
  onIndexChangeRequest: (nextIndex: number) => void
  onNavStateChange?: (state: LightboxCarouselNavState) => void
  onSwipeGesture?: (payload: { didSwipe: boolean; tapLike: boolean }) => void
  carouselPanelRef?: React.RefObject<HTMLDivElement | null>
}

const LightboxImageCarousel = forwardRef<ImageCarouselHandle, LightboxImageCarouselProps>(
  function LightboxImageCarousel({
  imageIds,
  currentIndex,
  maskPreviewSrc,
  zoomTransform,
  zoomTransition,
  swipeEnabled,
  onIndexChangeRequest,
  onNavStateChange,
  onSwipeGesture,
  carouselPanelRef,
}, ref) {
  const internalPanelRef = useRef<HTMLDivElement>(null)
  const panelRef = carouselPanelRef ?? internalPanelRef
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const [visualIndex, setVisualIndex] = useState(currentIndex)
  const [isDragging, setIsDragging] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const isAnimatingRef = useRef(false)
  const isDraggingRef = useRef(false)
  const [panelWidth, setPanelWidth] = useState(0)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeLockRef = useRef<TouchAxisLock>(null)
  const dragOffsetRef = useRef(0)
  const pendingIndexRef = useRef<number | null>(null)
  const currentIndexRef = useRef(currentIndex)

  const imageTotal = imageIds.length
  const showTrack = imageTotal > 1
  const slideWidth = panelWidth > 0 ? panelWidth : 0

  useEffect(() => {
    currentIndexRef.current = currentIndex
    if (!isAnimatingRef.current && !isDraggingRef.current) {
      setVisualIndex(currentIndex)
    }
  }, [currentIndex])

  useEffect(() => {
    isAnimatingRef.current = isAnimating
  }, [isAnimating])

  useEffect(() => {
    isDraggingRef.current = isDragging
  }, [isDragging])

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const updateWidth = () => {
      const nextWidth = Math.round(panel.clientWidth)
      if (nextWidth > 0) setPanelWidth(nextWidth)
    }
    updateWidth()

    const observer = new ResizeObserver(updateWidth)
    observer.observe(panel)
    window.addEventListener('resize', updateWidth)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [panelRef])

  const updateDragOffset = useCallback((offset: number) => {
    dragOffsetRef.current = offset
    setDragOffset(offset)
  }, [])

  useLayoutEffect(() => {
    onNavStateChange?.({ dragOffset, isDragging: isDragging || isAnimating, panelWidth })
  }, [dragOffset, isDragging, isAnimating, onNavStateChange, panelWidth])

  const goToIndex = useCallback((nextIndex: number) => {
    if (imageTotal <= 0) return
    const wrapped = ((nextIndex % imageTotal) + imageTotal) % imageTotal
    onIndexChangeRequest(wrapped)
  }, [imageTotal, onIndexChangeRequest])

  const commitPendingSlide = useCallback(() => {
    const result = commitCarouselPendingSlide({
      pendingIndexRef,
      isAnimatingRef,
      indexRef: currentIndexRef,
      setIsAnimating,
      goToIndex,
      updateDragOffset,
    })
    if (result.committed) {
      setVisualIndex(result.visualIndex)
    }
    return result.committed
  }, [goToIndex, updateDragOffset])

  const runSlideAnimation = useCallback((targetOffset: number, pendingIndex: number | null) => {
    pendingIndexRef.current = pendingIndex
    setIsDragging(false)
    isAnimatingRef.current = true
    setIsAnimating(true)

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateDragOffset(targetOffset)
      })
    })
  }, [updateDragOffset])

  const finalizeSlideAnimation = useCallback(() => {
    const pendingIndex = pendingIndexRef.current
    pendingIndexRef.current = null
    isAnimatingRef.current = false
    setIsAnimating(false)
    if (pendingIndex != null) {
      currentIndexRef.current = pendingIndex
      setVisualIndex(pendingIndex)
      goToIndex(pendingIndex)
    }
    updateDragOffset(0)
  }, [goToIndex, updateDragOffset])

  const handleTrackTransitionEnd = useCallback((event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== 'transform') return
    if (!isAnimating) return
    if (event.target !== trackRef.current) return
    finalizeSlideAnimation()
  }, [finalizeSlideAnimation, isAnimating])

  useEffect(() => {
    if (!isAnimating) return
    const timer = window.setTimeout(() => {
      if (pendingIndexRef.current != null || Math.abs(dragOffsetRef.current) > 0.5) {
        finalizeSlideAnimation()
      }
    }, CAROUSEL_SLIDE_TRANSITION_MS + 80)
    return () => window.clearTimeout(timer)
  }, [finalizeSlideAnimation, isAnimating])

  useEffect(() => {
    if (!isDragging && !isAnimating) {
      updateDragOffset(0)
    }
  }, [currentIndex, isAnimating, isDragging, updateDragOffset])

  const handleTouchStart = (event: React.TouchEvent) => {
    if (!swipeEnabled || !showTrack || slideWidth <= 0) return
    commitPendingSlide()
    if (!(event.target instanceof Element)) return
    if (!event.target.closest('img.saveable-image') && !event.target.closest('[data-lightbox-carousel]')) return

    touchStartRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
    swipeLockRef.current = null
    setIsDragging(false)
    updateDragOffset(0)
  }

  const handleTouchMove = (event: React.TouchEvent) => {
    if (isAnimatingRef.current) {
      commitPendingSlide()
    }
    if (!touchStartRef.current || !swipeEnabled || !showTrack || slideWidth <= 0) return

    const deltaX = event.touches[0].clientX - touchStartRef.current.x
    const deltaY = event.touches[0].clientY - touchStartRef.current.y
    const nextLock = resolveTouchAxisLock(deltaX, deltaY, swipeLockRef.current)

    if (!swipeLockRef.current && nextLock) {
      swipeLockRef.current = nextLock
      if (nextLock === 'vertical') {
        touchStartRef.current = null
        updateDragOffset(0)
        setIsDragging(false)
        onSwipeGesture?.({ didSwipe: false, tapLike: true })
        return
      }
      if (nextLock === 'horizontal') {
        setIsDragging(true)
      }
    }

    if (swipeLockRef.current !== 'horizontal') return

    if (!isTouchTapLike(deltaX, deltaY)) {
      onSwipeGesture?.({ didSwipe: true, tapLike: false })
    }

    event.preventDefault()
    const atFirst = currentIndexRef.current === 0 && deltaX > 0
    const atLast = currentIndexRef.current === imageTotal - 1 && deltaX < 0
    const resistance = atFirst || atLast ? 0.35 : 1
    updateDragOffset(deltaX * resistance)
  }

  const handleTouchEnd = (event: React.TouchEvent) => {
    if (!touchStartRef.current) return

    const locked = swipeLockRef.current
    const start = touchStartRef.current
    const endX = event.changedTouches[0]?.clientX ?? start.x
    const endY = event.changedTouches[0]?.clientY ?? start.y
    const totalDeltaX = endX - start.x
    const totalDeltaY = endY - start.y
    const tapLike = isTouchTapLike(totalDeltaX, totalDeltaY)
    const currentDragOffset = dragOffsetRef.current
    const activeIndex = currentIndexRef.current

    touchStartRef.current = null
    swipeLockRef.current = null
    setIsDragging(false)

    if (locked !== 'horizontal' || slideWidth <= 0) {
      updateDragOffset(0)
      onSwipeGesture?.({ didSwipe: false, tapLike })
      return
    }

    const threshold = resolveTouchSwipeThreshold(slideWidth)
    const shouldGoNext = currentDragOffset <= -threshold && activeIndex < imageTotal - 1
    const shouldGoPrev = currentDragOffset >= threshold && activeIndex > 0

    if (shouldGoNext) {
      onSwipeGesture?.({ didSwipe: true, tapLike: false })
      runSlideAnimation(-slideWidth, activeIndex + 1)
      return
    }

    if (shouldGoPrev) {
      onSwipeGesture?.({ didSwipe: true, tapLike: false })
      runSlideAnimation(slideWidth, activeIndex - 1)
      return
    }

    if (!tapLike) {
      onSwipeGesture?.({ didSwipe: true, tapLike: false })
    } else {
      onSwipeGesture?.({ didSwipe: false, tapLike: true })
    }

    runSlideAnimation(0, null)
  }

  const animateStep = useCallback((direction: -1 | 1) => {
    if (slideWidth <= 0 || isDraggingRef.current || imageTotal <= 1) return
    if (isAnimatingRef.current) commitPendingSlide()
    const current = currentIndexRef.current
    if (direction < 0 && current <= 0) return
    if (direction > 0 && current >= imageTotal - 1) return
    const next = current + direction
    runSlideAnimation(direction > 0 ? -slideWidth : slideWidth, next)
  }, [commitPendingSlide, imageTotal, runSlideAnimation, slideWidth])

  useImperativeHandle(ref, () => ({
    animatePrev: () => animateStep(-1),
    animateNext: () => animateStep(1),
  }), [animateStep])

  const handleTouchCancel = () => {
    commitPendingSlide()
    touchStartRef.current = null
    swipeLockRef.current = null
    setIsDragging(false)
    if (!isAnimatingRef.current) {
      runSlideAnimation(0, null)
    }
    onSwipeGesture?.({ didSwipe: false, tapLike: true })
  }

  const translateX = showTrack && slideWidth > 0
    ? -(visualIndex * slideWidth) + dragOffset
    : 0

  // 仅在补间动画阶段启用 transition，避免初次定位或外部切 index 时误播滑动
  const trackTransition = isDragging || !isAnimating
    ? 'none'
    : `transform ${CAROUSEL_SLIDE_TRANSITION_MS}ms ${CAROUSEL_SLIDE_EASING}`

  return (
    <div
      ref={panelRef}
      data-lightbox-carousel
      className="relative h-[100dvh] w-[100vw] overflow-hidden"
      style={{ touchAction: 'none' }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <div
        ref={trackRef}
        className="flex h-full flex-nowrap"
        style={{
          width: slideWidth > 0 ? slideWidth * imageTotal : '100%',
          transform: slideWidth > 0 ? `translate3d(${translateX}px, 0, 0)` : undefined,
          transition: trackTransition,
          willChange: 'transform',
        }}
        onTransitionEnd={handleTrackTransitionEnd}
      >
        {imageIds.map((imageId, index) => (
          <div
            key={imageId}
            className="h-full flex-shrink-0"
            style={{ width: slideWidth > 0 ? slideWidth : '100%' }}
          >
            <div
              className="relative flex h-full w-full items-center justify-center"
              style={{
                transform: index === visualIndex ? zoomTransform : 'none',
                transition: index === visualIndex ? zoomTransition : 'none',
                willChange: index === visualIndex ? 'transform' : undefined,
              }}
            >
              <LightboxSlide
                imageId={imageId}
                isActive={index === visualIndex}
                imageIndex={index + 1}
                imageTotal={imageTotal}
                maskPreviewSrc={index === visualIndex ? maskPreviewSrc : undefined}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})

export default LightboxImageCarousel