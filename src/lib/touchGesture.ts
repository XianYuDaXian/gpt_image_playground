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