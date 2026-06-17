export type TouchAxisLock = 'horizontal' | 'vertical' | null

/** 视为点击的最大位移（像素） */
export const TOUCH_TAP_SLOP = 10

/** 锁定滑动方向前所需的最小位移 */
export const TOUCH_AXIS_LOCK_MIN = 16

/** 水平 / 垂直方向判定倍率，越大越不容易误触 */
export const TOUCH_AXIS_LOCK_RATIO = 1.35

export function resolveTouchAxisLock(
  deltaX: number,
  deltaY: number,
  currentLock: TouchAxisLock,
): TouchAxisLock {
  if (currentLock) return currentLock

  const absX = Math.abs(deltaX)
  const absY = Math.abs(deltaY)

  if (absY >= TOUCH_AXIS_LOCK_MIN && absY > absX * TOUCH_AXIS_LOCK_RATIO) {
    return 'vertical'
  }
  if (absX >= TOUCH_AXIS_LOCK_MIN && absX > absY * TOUCH_AXIS_LOCK_RATIO) {
    return 'horizontal'
  }
  return null
}

export function isTouchTapLike(deltaX: number, deltaY: number, slop = TOUCH_TAP_SLOP) {
  return Math.hypot(deltaX, deltaY) <= slop
}

export function resolveTouchSwipeThreshold(containerWidth: number, max = 72, ratio = 0.18) {
  return Math.min(max, containerWidth * ratio)
}

export function isCarouselSwipeTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('img.saveable-image'))
}

export function isDetailCarouselSwipeTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('img.saveable-image'))
}

export const LIGHTBOX_NAV_BUTTON_SIZE = 44

export function readSafeAreaInsets() {
  if (typeof document === 'undefined') {
    return { top: 0, right: 0, bottom: 0, left: 0 }
  }
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => {
    const raw = style.getPropertyValue(name).trim()
    const value = parseFloat(raw)
    return Number.isFinite(value) ? value : 0
  }
  return {
    top: read('--safe-area-top'),
    right: read('--safe-area-right'),
    bottom: read('--safe-area-bottom'),
    left: read('--safe-area-left'),
  }
}

export interface LightboxDisplayRect {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
  centerY: number
}

/** 大图模式图片显示区域（与 max-h 90dvh / max-w 92vw + 居中一致，不受入场动画 transform 影响） */
export function resolveLightboxDisplayRect(image: HTMLImageElement): LightboxDisplayRect | null {
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return null

  const safe = readSafeAreaInsets()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const availableWidth = viewportWidth - safe.left - safe.right
  const availableHeight = viewportHeight - safe.top - safe.bottom
  const maxWidth = Math.min(availableWidth * 0.92, availableWidth)
  const maxHeight = availableHeight * 0.9
  const naturalRatio = image.naturalWidth / image.naturalHeight

  let width = maxWidth
  let height = width / naturalRatio
  if (height > maxHeight) {
    height = maxHeight
    width = height * naturalRatio
  }

  const left = safe.left + (availableWidth - width) / 2
  const top = safe.top + (availableHeight - height) / 2

  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    centerY: top + height / 2,
  }
}

/** 大图翻页按钮位置：贴在图片两侧，并限制在安全可视区内 */
export function resolveLightboxNavButtonPositions(
  displayRect: LightboxDisplayRect,
  options?: { gap?: number; buttonSize?: number },
) {
  const gap = options?.gap ?? 12
  const buttonSize = options?.buttonSize ?? LIGHTBOX_NAV_BUTTON_SIZE
  const safe = readSafeAreaInsets()
  const edgePadding = 8
  const minLeft = safe.left + edgePadding
  const maxLeft = window.innerWidth - safe.right - edgePadding - buttonSize
  const minCenterY = safe.top + edgePadding + buttonSize / 2
  const maxCenterY = window.innerHeight - safe.bottom - edgePadding - buttonSize / 2
  const centerY = Math.max(minCenterY, Math.min(maxCenterY, displayRect.centerY))

  let prevLeft = displayRect.left - gap - buttonSize
  prevLeft = Math.max(minLeft, Math.min(prevLeft, maxLeft))

  let nextLeft = displayRect.right + gap
  nextLeft = Math.max(minLeft, Math.min(nextLeft, maxLeft))

  if (prevLeft + buttonSize + gap > nextLeft) {
    const split = (minLeft + maxLeft) / 2
    prevLeft = Math.max(minLeft, split - buttonSize - gap / 2)
    nextLeft = Math.min(maxLeft, split + gap / 2)
  }

  return {
    prevLeft,
    prevTop: centerY,
    nextLeft,
    nextTop: centerY,
  }
}

/** 判断点击是否落在 object-contain 实际绘制的图片区域内 */
export function isPointInsideObjectContainImage(
  image: HTMLImageElement,
  localX: number,
  localY: number,
) {
  const { width: containerWidth, height: containerHeight } = image.getBoundingClientRect()
  if (
    containerWidth <= 0
    || containerHeight <= 0
    || image.naturalWidth <= 0
    || image.naturalHeight <= 0
  ) {
    return false
  }

  const naturalRatio = image.naturalWidth / image.naturalHeight
  const containerRatio = containerWidth / containerHeight

  let renderedWidth: number
  let renderedHeight: number
  let offsetX: number
  let offsetY: number

  if (naturalRatio > containerRatio) {
    renderedWidth = containerWidth
    renderedHeight = containerWidth / naturalRatio
    offsetX = 0
    offsetY = (containerHeight - renderedHeight) / 2
  } else {
    renderedHeight = containerHeight
    renderedWidth = containerHeight * naturalRatio
    offsetX = (containerWidth - renderedWidth) / 2
    offsetY = 0
  }

  return (
    localX >= offsetX
    && localX <= offsetX + renderedWidth
    && localY >= offsetY
    && localY <= offsetY + renderedHeight
  )
}

export function isLightboxSwipeTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('img.saveable-image'))
}

/** 轮播松手后补间时长 */
export const CAROUSEL_SLIDE_TRANSITION_MS = 420

/** 轮播松手后缓动曲线 */
export const CAROUSEL_SLIDE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

export interface ImageCarouselHandle {
  animatePrev: () => void
  animateNext: () => void
}

interface CommitCarouselPendingSlideOptions {
  pendingIndexRef: { current: number | null }
  isAnimatingRef: { current: boolean }
  indexRef: { current: number }
  setIsAnimating: (value: boolean) => void
  goToIndex: (index: number) => void
  updateDragOffset: (offset: number) => void
}

export interface CommitCarouselPendingSlideResult {
  committed: boolean
  visualIndex: number
}

/** 立即结束轮播补间并提交待定 index，便于连续滑动打断 */
export function commitCarouselPendingSlide(
  options: CommitCarouselPendingSlideOptions,
): CommitCarouselPendingSlideResult {
  const visualIndex = options.indexRef.current
  if (!options.isAnimatingRef.current) {
    return { committed: false, visualIndex }
  }

  const pendingIndex = options.pendingIndexRef.current
  options.pendingIndexRef.current = null
  options.isAnimatingRef.current = false
  options.setIsAnimating(false)

  if (pendingIndex != null) {
    options.indexRef.current = pendingIndex
    options.goToIndex(pendingIndex)
  }

  options.updateDragOffset(0)
  return { committed: true, visualIndex: options.indexRef.current }
}