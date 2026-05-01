const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'

function isInsideLightbox(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-lightbox-root]'))
}

function findScrollableAncestor(target: EventTarget | null) {
  let node = target instanceof Element ? target : null
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node)
    const overflowY = style.overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
    node = node.parentElement
  }
  return document.scrollingElement as HTMLElement | null
}

export function installMobileViewportGuards() {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (viewport) viewport.content = VIEWPORT_CONTENT

  const preventPageGesture = (event: Event) => {
    if (!isInsideLightbox(event.target)) event.preventDefault()
  }

  const preventMultiTouchPageZoom = (event: TouchEvent) => {
    if (event.touches.length > 1 && !isInsideLightbox(event.target)) event.preventDefault()
  }

  const overscrollTouch = {
    startY: 0,
    scrollable: null as HTMLElement | null,
  }

  const rememberTouchStart = (event: TouchEvent) => {
    if (isInsideLightbox(event.target) || event.touches.length !== 1) return
    overscrollTouch.startY = event.touches[0]?.clientY ?? 0
    overscrollTouch.scrollable = findScrollableAncestor(event.target)
  }

  const preventPageRubberBand = (event: TouchEvent) => {
    if (isInsideLightbox(event.target) || event.touches.length !== 1) return

    const currentY = event.touches[0]?.clientY ?? overscrollTouch.startY
    const deltaY = currentY - overscrollTouch.startY
    const scrollable = overscrollTouch.scrollable ?? findScrollableAncestor(event.target)
    if (!scrollable) return

    const maxScrollTop = Math.max(0, scrollable.scrollHeight - scrollable.clientHeight)
    const scrollTop = scrollable.scrollTop
    const pullingDownAtTop = scrollTop <= 0 && deltaY > 0
    const pullingUpAtBottom = scrollTop >= maxScrollTop - 1 && deltaY < 0

    if (pullingDownAtTop || pullingUpAtBottom) {
      event.preventDefault()
    }
  }

  document.addEventListener('gesturestart', preventPageGesture, { passive: false })
  document.addEventListener('gesturechange', preventPageGesture, { passive: false })
  document.addEventListener('touchstart', rememberTouchStart, { passive: true })
  document.addEventListener('touchmove', preventPageRubberBand, { passive: false })
  document.addEventListener('touchmove', preventMultiTouchPageZoom, { passive: false })
}
