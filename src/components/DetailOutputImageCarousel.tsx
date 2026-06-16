import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { cacheTaskImageForEditing } from '../store'
import { useTrackedImageLoad } from '../hooks/useTrackedImageLoad'
import {
  CAROUSEL_SLIDE_EASING,
  CAROUSEL_SLIDE_TRANSITION_MS,
  isDetailCarouselSwipeTarget,
  isTouchTapLike,
  resolveTouchAxisLock,
  resolveTouchSwipeThreshold,
  commitCarouselPendingSlide,
  type ImageCarouselHandle,
  type TouchAxisLock,
} from '../lib/touchGesture'
import ImageLoadingOverlay from './ImageLoadingOverlay'

function resolveTaskImageSrc(
  imageId: string,
  imageSrcs: Record<string, string>,
  task: {
    imageUrlsById?: Record<string, string>
    imagePreviewUrlsById?: Record<string, string>
    imageBytesById?: Record<string, number>
  },
) {
  if (!imageId) return ''
  return imageSrcs[imageId] || task.imageUrlsById?.[imageId] || task.imagePreviewUrlsById?.[imageId] || ''
}

interface OutputImageSlideProps {
  imageId: string
  src: string
  expectedBytes: number | null
  isActive: boolean
  imageIndex: number
  imageTotal: number
  isTaskBlurred: boolean
  originalSrc?: string
  onReady: (imageId: string, image: HTMLImageElement) => void
  onImageTap: () => void
}

function OutputImageSlide({
  imageId,
  src,
  expectedBytes,
  isActive,
  imageIndex,
  imageTotal,
  isTaskBlurred,
  originalSrc,
  onReady,
  onImageTap,
}: OutputImageSlideProps) {
  const imageRef = useRef<HTMLImageElement>(null)
  const {
    displaySrc,
    isLoading,
    showLoadingOverlay,
    progress,
  } = useTrackedImageLoad(src, {
    imageId,
    expectedBytes,
    enabled: Boolean(imageId && src),
  })

  useEffect(() => {
    if (!isActive || !displaySrc || isLoading) return
    const image = imageRef.current
    if (!image?.complete || image.naturalWidth <= 0) return
    onReady(imageId, image)
  }, [displaySrc, imageId, isActive, isLoading, onReady])

  return (
    <div className="relative flex h-full w-full flex-shrink-0 items-center justify-center">
      {isActive && showLoadingOverlay && (
        <ImageLoadingOverlay
          progress={progress}
          imageIndex={imageIndex}
          imageTotal={imageTotal}
          variant="light"
        />
      )}
      {displaySrc ? (
        <img
          ref={imageRef}
          src={displaySrc}
          data-image-id={imageId}
          data-original-src={originalSrc}
          className={`saveable-image max-h-[calc(100%-3.25rem)] max-w-full object-contain transition duration-200 md:max-h-[calc(100%-2rem)] md:max-w-[calc(100%-2rem)] ${
            isActive ? 'cursor-pointer' : ''
          } ${showLoadingOverlay && isActive ? 'opacity-0' : 'opacity-100'} ${
            isTaskBlurred ? 'scale-[1.02] blur-md' : ''
          }`}
          onLoad={(event) => {
            if (!isActive) return
            onReady(imageId, event.currentTarget)
            if (originalSrc) {
              void cacheTaskImageForEditing(imageId, originalSrc, event.currentTarget)
            }
          }}
          onClick={() => {
            if (!isActive || isLoading) return
            onImageTap()
          }}
          alt=""
          draggable={false}
        />
      ) : isActive && showLoadingOverlay ? null : (
        <div className="h-full w-full" />
      )}
    </div>
  )
}

interface DetailOutputImageCarouselProps {
  task: {
    id: string
    outputImages: string[]
    imageUrlsById?: Record<string, string>
    imagePreviewUrlsById?: Record<string, string>
    imageBytesById?: Record<string, number>
  }
  imageSrcs: Record<string, string>
  imageIndex: number
  onImageIndexChange: (index: number) => void
  isTaskBlurred: boolean
  onActiveImageReady: (imageId: string, image: HTMLImageElement) => void
  onOpenLightbox: (imageId: string) => void
}

const DetailOutputImageCarousel = forwardRef<ImageCarouselHandle, DetailOutputImageCarouselProps>(
  function DetailOutputImageCarousel({
  task,
  imageSrcs,
  imageIndex,
  onImageIndexChange,
  isTaskBlurred,
  onActiveImageReady,
  onOpenLightbox,
}, ref) {
  const trackRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const [visualIndex, setVisualIndex] = useState(imageIndex)
  const [isDragging, setIsDragging] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const isAnimatingRef = useRef(false)
  const isDraggingRef = useRef(false)
  const [panelWidth, setPanelWidth] = useState(0)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeLockRef = useRef<TouchAxisLock>(null)
  const dragOffsetRef = useRef(0)
  const suppressImageTapRef = useRef(false)
  const pendingIndexRef = useRef<number | null>(null)
  const imageIndexRef = useRef(imageIndex)

  const outputLen = task.outputImages.length
  const slideWidth = panelWidth > 0 ? panelWidth : 0

  useEffect(() => {
    imageIndexRef.current = imageIndex
    if (!isAnimatingRef.current && !isDraggingRef.current) {
      setVisualIndex(imageIndex)
    }
  }, [imageIndex])

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
  }, [])

  // 详情图区禁止双指捏合，仅大图模式可缩放
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const blockMultiTouch = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault()
      }
    }

    panel.addEventListener('touchstart', blockMultiTouch, { passive: false })
    panel.addEventListener('touchmove', blockMultiTouch, { passive: false })
    return () => {
      panel.removeEventListener('touchstart', blockMultiTouch)
      panel.removeEventListener('touchmove', blockMultiTouch)
    }
  }, [])

  const goToIndex = useCallback((nextIndex: number) => {
    if (outputLen <= 0) return
    const wrapped = ((nextIndex % outputLen) + outputLen) % outputLen
    onImageIndexChange(wrapped)
  }, [onImageIndexChange, outputLen])

  const updateDragOffset = useCallback((offset: number) => {
    dragOffsetRef.current = offset
    setDragOffset(offset)
  }, [])

  const commitPendingSlide = useCallback(() => {
    const result = commitCarouselPendingSlide({
      pendingIndexRef,
      isAnimatingRef,
      indexRef: imageIndexRef,
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
      imageIndexRef.current = pendingIndex
      setVisualIndex(pendingIndex)
      goToIndex(pendingIndex)
    }
    updateDragOffset(0)
  }, [goToIndex, updateDragOffset])

  const handleTrackTransitionEnd = useCallback((event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== 'transform') return
    if (!isAnimatingRef.current) return
    if (event.target !== trackRef.current) return
    finalizeSlideAnimation()
  }, [finalizeSlideAnimation])

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
  }, [imageIndex, isAnimating, isDragging, updateDragOffset])

  const handleTouchStart = (event: React.TouchEvent) => {
    if (outputLen <= 1 || slideWidth <= 0) return
    const committed = commitPendingSlide()
    if (event.touches.length > 1) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!committed && !isDetailCarouselSwipeTarget(event.target)) return

    touchStartRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
    swipeLockRef.current = null
    suppressImageTapRef.current = false
    setIsDragging(false)
    updateDragOffset(0)
  }

  const handleTouchMove = (event: React.TouchEvent) => {
    if (event.touches.length > 1) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (isAnimatingRef.current) {
      commitPendingSlide()
      if (!touchStartRef.current && event.touches.length > 0 && isDetailCarouselSwipeTarget(event.target)) {
        touchStartRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
        swipeLockRef.current = 'horizontal'
        suppressImageTapRef.current = true
        setIsDragging(true)
      }
    }
    if (!touchStartRef.current || outputLen <= 1 || slideWidth <= 0) return

    const deltaX = event.touches[0].clientX - touchStartRef.current.x
    const deltaY = event.touches[0].clientY - touchStartRef.current.y
    const nextLock = resolveTouchAxisLock(deltaX, deltaY, swipeLockRef.current)

    if (!swipeLockRef.current && nextLock) {
      swipeLockRef.current = nextLock
      if (nextLock === 'vertical') {
        touchStartRef.current = null
        updateDragOffset(0)
        setIsDragging(false)
        return
      }
      if (nextLock === 'horizontal') {
        setIsDragging(true)
      }
    }

    if (swipeLockRef.current !== 'horizontal') return

    if (!isTouchTapLike(deltaX, deltaY)) {
      suppressImageTapRef.current = true
    }

    event.preventDefault()
    const activeIndex = imageIndexRef.current
    const atFirst = activeIndex === 0 && deltaX > 0
    const atLast = activeIndex === outputLen - 1 && deltaX < 0
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
    const activeIndex = imageIndexRef.current

    touchStartRef.current = null
    swipeLockRef.current = null
    setIsDragging(false)

    if (locked !== 'horizontal' || slideWidth <= 0) {
      updateDragOffset(0)
      return
    }

    if (!tapLike) {
      suppressImageTapRef.current = true
    }

    const threshold = resolveTouchSwipeThreshold(slideWidth)
    const shouldGoNext = currentDragOffset <= -threshold && activeIndex < outputLen - 1
    const shouldGoPrev = currentDragOffset >= threshold && activeIndex > 0

    if (shouldGoNext) {
      runSlideAnimation(-slideWidth, activeIndex + 1)
      return
    }

    if (shouldGoPrev) {
      runSlideAnimation(slideWidth, activeIndex - 1)
      return
    }

    runSlideAnimation(0, null)
  }

  const handleTouchCancel = () => {
    commitPendingSlide()
    touchStartRef.current = null
    swipeLockRef.current = null
    setIsDragging(false)
    if (!isAnimatingRef.current) {
      runSlideAnimation(0, null)
    }
  }

  const animateStep = useCallback((direction: -1 | 1) => {
    if (slideWidth <= 0 || isDraggingRef.current || outputLen <= 1) return
    if (isAnimatingRef.current) commitPendingSlide()
    const current = imageIndexRef.current
    if (direction < 0 && current <= 0) return
    if (direction > 0 && current >= outputLen - 1) return
    const next = current + direction
    runSlideAnimation(direction > 0 ? -slideWidth : slideWidth, next)
  }, [commitPendingSlide, outputLen, runSlideAnimation, slideWidth])

  useImperativeHandle(ref, () => ({
    animatePrev: () => animateStep(-1),
    animateNext: () => animateStep(1),
  }), [animateStep])

  const handleImageTap = useCallback((imageId: string) => {
    if (suppressImageTapRef.current) {
      suppressImageTapRef.current = false
      return
    }
    onOpenLightbox(imageId)
  }, [onOpenLightbox])

  const translateX = slideWidth > 0
    ? -(visualIndex * slideWidth) + dragOffset
    : 0

  // 仅在补间动画阶段启用 transition，避免打开大图或缩略图跳切时误播滑动
  const trackTransition = isDragging || !isAnimating
    ? 'none'
    : `transform ${CAROUSEL_SLIDE_TRANSITION_MS}ms ${CAROUSEL_SLIDE_EASING}`

  return (
    <div
      ref={panelRef}
      data-detail-carousel
      className="relative h-full w-full overflow-hidden"
      style={{ touchAction: outputLen > 1 ? (isAnimating ? 'none' : 'pan-y') : 'manipulation' }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <div
        ref={trackRef}
        className="flex h-full flex-nowrap will-change-transform"
        style={{
          width: slideWidth > 0 ? slideWidth * outputLen : `${outputLen * 100}%`,
          transform: slideWidth > 0 ? `translate3d(${translateX}px, 0, 0)` : undefined,
          transition: trackTransition,
        }}
        onTransitionEnd={handleTrackTransitionEnd}
      >
        {task.outputImages.map((imageId, index) => {
          const src = resolveTaskImageSrc(imageId, imageSrcs, task)
          const expectedBytes = task.imageBytesById?.[imageId] ?? null
          return (
            <div
              key={imageId}
              className="h-full flex-shrink-0"
              style={{ width: slideWidth > 0 ? slideWidth : '100%' }}
            >
              <OutputImageSlide
                imageId={imageId}
                src={src}
                expectedBytes={expectedBytes}
                isActive={index === visualIndex}
                imageIndex={index + 1}
                imageTotal={outputLen}
                isTaskBlurred={isTaskBlurred}
                originalSrc={task.imageUrlsById?.[imageId]}
                onReady={onActiveImageReady}
                onImageTap={() => handleImageTap(imageId)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default DetailOutputImageCarousel