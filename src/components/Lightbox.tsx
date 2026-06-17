import { Suspense, lazy, useEffect, useState, useRef, useCallback, useMemo, useLayoutEffect } from 'react'
import { useStore, getCachedImage, ensureTaskImageAvailable } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { resolveTaskImageDisplaySrc } from '../lib/resolveTaskImageDisplay'
import {
  isLightboxSwipeTarget,
  isTouchTapLike,
  resolveLightboxDisplayRect,
  resolveLightboxNavButtonPositions,
  type ImageCarouselHandle,
} from '../lib/touchGesture'
import { resolveLightboxCompareTarget } from '../lib/lightboxCompare'
import LightboxImageCarousel, { type LightboxCarouselNavState } from './LightboxImageCarousel'
import LightboxImageCompare from './LightboxImageCompare'

const lightboxNavBtnClass =
  'fixed z-[70] -translate-y-1/2 rounded-full bg-black/45 p-1.5 text-white backdrop-blur-sm transition hover:bg-black/60'

const ReferenceImageEditorModal = lazy(() => import('./ReferenceImageEditorModal'))

const MIN_SCALE = 1
const MAX_SCALE = 10

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function isLightboxControl(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-lightbox-control]'))
}

export default function Lightbox() {
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const lightboxImageList = useStore((s) => s.lightboxImageList)
  const lightboxStartEditor = useStore((s) => s.lightboxStartEditor)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setLightboxStartEditor = useStore((s) => s.setLightboxStartEditor)
  const inputImages = useStore((s) => s.inputImages)
  const [asyncSrc, setAsyncSrc] = useState('')
  const [compareAsyncSrc, setCompareAsyncSrc] = useState('')
  const [showEditor, setShowEditor] = useState(false)
  const maskDraft = useStore((s) => s.maskDraft)
  const tasks = useStore((s) => s.tasks)

  const syncSrc = useMemo(
    () => (lightboxImageId ? resolveTaskImageDisplaySrc(lightboxImageId, tasks) : ''),
    [lightboxImageId, tasks],
  )
  const src = syncSrc || asyncSrc

  const [maskImageSrc, setMaskImageSrc] = useState('')
  const [maskPreviewSrc, setMaskPreviewSrc] = useState('')

  const close = useCallback(() => setLightboxImageId(null), [setLightboxImageId])
  useCloseOnEscape(Boolean(lightboxImageId), close)

  // 同步缓存未命中时再异步拉取，避免打开大图时先清空 src 触发加载动画
  useEffect(() => {
    let cancelled = false

    if (!lightboxImageId) {
      setAsyncSrc('')
      setShowEditor(false)
      setLightboxStartEditor(false)
      return
    }

    if (syncSrc) {
      setAsyncSrc('')
      return
    }

    const imageId = lightboxImageId
    const cached = getCachedImage(imageId)
    if (cached) {
      setAsyncSrc(cached)
      return
    }

    ensureTaskImageAvailable(imageId).then((url) => {
      if (!cancelled && url) setAsyncSrc(url)
    })

    return () => {
      cancelled = true
    }
  }, [lightboxImageId, syncSrc, setLightboxStartEditor])

  const isReferenceImage = Boolean(lightboxImageId && inputImages.some((image) => image.id === lightboxImageId))
  const compareTarget = useMemo(
    () => (lightboxImageId ? resolveLightboxCompareTarget(lightboxImageId, tasks) : null),
    [lightboxImageId, tasks],
  )
  const compareSyncSrc = useMemo(
    () => (compareTarget ? resolveTaskImageDisplaySrc(compareTarget.compareImageId, tasks) : ''),
    [compareTarget, tasks],
  )
  const compareSrc = compareSyncSrc || compareAsyncSrc

  useEffect(() => {
    let cancelled = false

    if (!compareTarget?.compareImageId) {
      setCompareAsyncSrc('')
      return
    }

    if (compareSyncSrc) {
      setCompareAsyncSrc('')
      return
    }

    const compareImageId = compareTarget.compareImageId
    const cached = getCachedImage(compareImageId)
    if (cached) {
      setCompareAsyncSrc(cached)
      return
    }

    ensureTaskImageAvailable(compareImageId).then((url) => {
      if (!cancelled && url) setCompareAsyncSrc(url)
    })

    return () => {
      cancelled = true
    }
  }, [compareSyncSrc, compareTarget?.compareImageId])

  useEffect(() => {
    if (!lightboxImageId || !src || !lightboxStartEditor) return
    setShowEditor(true)
    setLightboxStartEditor(false)
  }, [lightboxImageId, lightboxStartEditor, setLightboxStartEditor, src])

  // 遮罩图加载
  useEffect(() => {
    let cancelled = false

    if (!lightboxImageId) {
      setMaskImageSrc('')
      return
    }

    if (maskDraft?.targetImageId === lightboxImageId) {
      setMaskImageSrc(maskDraft.maskDataUrl)
      return
    }

    setMaskImageSrc('')

    const taskWithMask = tasks.find((t) => t.maskTargetImageId === lightboxImageId && t.maskImageId)
    if (taskWithMask?.maskImageId) {
      const maskImageId = taskWithMask.maskImageId
      const cached = getCachedImage(maskImageId)
      if (cached) {
        setMaskImageSrc(cached)
      } else {
        ensureTaskImageAvailable(maskImageId).then((url) => {
          if (!cancelled && url) setMaskImageSrc(url)
        })
      }
    } else {
      setMaskImageSrc('')
    }

    return () => {
      cancelled = true
    }
  }, [lightboxImageId, maskDraft?.targetImageId, maskDraft?.maskDataUrl, tasks])

  // 生成遮罩预览
  useEffect(() => {
    let cancelled = false
    if (!src || !maskImageSrc) {
      setMaskPreviewSrc('')
      return
    }

    createMaskPreviewDataUrl(src, maskImageSrc)
      .then((url) => {
        if (!cancelled) setMaskPreviewSrc(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewSrc('')
      })

    return () => {
      cancelled = true
    }
  }, [src, maskImageSrc])

  // 导航
  const currentIndex = lightboxImageId ? lightboxImageList.indexOf(lightboxImageId) : -1
  const total = lightboxImageList.length
  const showNav = total > 1
  const canGoPrev = currentIndex > 0
  const canGoNext = currentIndex >= 0 && currentIndex < total - 1

  const goToIndex = useCallback((idx: number) => {
    if (lightboxImageList.length === 0) return
    const wrapped = ((idx % lightboxImageList.length) + lightboxImageList.length) % lightboxImageList.length
    setLightboxImageId(lightboxImageList[wrapped], lightboxImageList)
  }, [lightboxImageList, setLightboxImageId])

  if (!lightboxImageId) return null

  return (
    <>
      <LightboxInner
        imageId={lightboxImageId}
        imageIds={lightboxImageList}
        maskPreviewSrc={maskPreviewSrc}
        onClose={close}
        showNav={showNav}
        canGoPrev={canGoPrev}
        canGoNext={canGoNext}
        currentIndex={currentIndex}
        total={total}
        onGoToIndex={goToIndex}
        isReferenceImage={isReferenceImage}
        primarySrc={src}
        compareTarget={compareTarget}
        compareSrc={compareSrc}
        onEdit={() => setShowEditor(true)}
      />
      {showEditor && lightboxImageId && src ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/55 backdrop-blur-md text-sm text-white/70">
              正在加载编辑器...
            </div>
          }
        >
          <ReferenceImageEditorModal
            imageId={lightboxImageId}
            src={src}
            saveMode={isReferenceImage ? 'replace-input' : 'append-input'}
            onClose={() => setShowEditor(false)}
          />
        </Suspense>
      ) : null}
    </>
  )
}

interface LightboxInnerProps {
  imageId: string
  imageIds: string[]
  maskPreviewSrc?: string
  onClose: () => void
  showNav: boolean
  canGoPrev: boolean
  canGoNext: boolean
  currentIndex: number
  total: number
  onGoToIndex: (index: number) => void
  isReferenceImage: boolean
  primarySrc: string
  compareTarget: ReturnType<typeof resolveLightboxCompareTarget>
  compareSrc: string
  onEdit: () => void
}

/** 内部组件：保证挂载时 DOM 已经存在，所有 ref / effect 都可靠 */
function LightboxInner({
  imageId,
  imageIds,
  maskPreviewSrc,
  onClose,
  showNav,
  canGoPrev,
  canGoNext,
  currentIndex,
  total,
  onGoToIndex,
  isReferenceImage,
  primarySrc,
  compareTarget,
  compareSrc,
  onEdit,
}: LightboxInnerProps) {
  const [compareMode, setCompareMode] = useState(false)
  const canCompare = Boolean(compareTarget && compareSrc && primarySrc)
  const containerRef = useRef<HTMLDivElement>(null)
  const carouselPanelRef = useRef<HTMLDivElement>(null)
  const carouselWrapRef = useRef<HTMLDivElement>(null)
  const carouselRef = useRef<ImageCarouselHandle>(null)
  const [carouselNavState, setCarouselNavState] = useState<LightboxCarouselNavState>({
    dragOffset: 0,
    isDragging: false,
    panelWidth: 0,
  })
  const [lightboxNavAnchor, setLightboxNavAnchor] = useState<{
    prevX: number
    prevY: number
    nextX: number
    nextY: number
  } | null>(null)
  // 用 ref 追踪最新变换，避免闭包过期
  const scaleRef = useRef(1)
  const txRef = useRef(0)
  const tyRef = useRef(0)

  // 仅用于触发渲染
  const [, forceRender] = useState(0)
  const rerender = useCallback(() => forceRender((n) => n + 1), [])

  // 缩放倍率显示：2s 无操作后自动隐藏
  const [showZoomBadge, setShowZoomBadge] = useState(false)
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 拖拽状态
  const dragRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    baseTx: 0,
    baseTy: 0,
  })

  // 双指缩放状态
  const pinchRef = useRef({
    active: false,
    startDist: 0,
    startScale: 1,
    startTx: 0,
    startTy: 0,
    midX: 0,
    midY: 0,
  })

  // 双击检测（触控）
  const tapRef = useRef({ time: 0, x: 0, y: 0 })
  const hadMultiTouchRef = useRef(false)
  const touchStartedOnImageRef = useRef(false)

  // 判断本次 mousedown → mouseup 是否发生了拖拽，用于区分点击和拖拽
  const didDragRef = useRef(false)
  const suppressNextClickRef = useRef(false)

  const didNavSwipeRef = useRef(false)
  const closeTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 连点方向键后短时间内屏蔽双击缩放，避免误触 300%
  const suppressDoubleClickZoomUntilRef = useRef(0)

  const markNavInteraction = useCallback(() => {
    suppressDoubleClickZoomUntilRef.current = Date.now() + 450
    suppressNextClickRef.current = true
  }, [])

  const handleNavPrev = useCallback(() => {
    markNavInteraction()
    carouselRef.current?.animatePrev()
  }, [markNavInteraction])

  const handleNavNext = useCallback(() => {
    markNavInteraction()
    carouselRef.current?.animateNext()
  }, [markNavInteraction])

  const stopControlDoubleClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    suppressDoubleClickZoomUntilRef.current = Date.now() + 450
  }, [])

  const handleCarouselSwipeGesture = useCallback((payload: { didSwipe: boolean; tapLike: boolean }) => {
    if (payload.didSwipe) {
      didNavSwipeRef.current = true
      suppressNextClickRef.current = true
      if (closeTapTimerRef.current) {
        clearTimeout(closeTapTimerRef.current)
        closeTapTimerRef.current = null
      }
      tapRef.current = { time: 0, x: 0, y: 0 }
    }
  }, [])

  // 切换图片时重置缩放与对比模式
  useEffect(() => {
    scaleRef.current = 1
    txRef.current = 0
    tyRef.current = 0
    didNavSwipeRef.current = false
    setCompareMode(false)
    rerender()
  }, [imageId, rerender])

  useEffect(() => {
    if (!canCompare) setCompareMode(false)
  }, [canCompare])

  useEffect(() => {
    if (!compareMode) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setCompareMode(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [compareMode])

  useEffect(() => {
    const suppressClick = () => {
      suppressNextClickRef.current = true
    }

    window.addEventListener('image-context-menu-dismiss-lightbox-click', suppressClick)
    return () => window.removeEventListener('image-context-menu-dismiss-lightbox-click', suppressClick)
  }, [])

  const getCenter = useCallback(() => {
    const rect = carouselPanelRef.current?.getBoundingClientRect() ?? containerRef.current?.getBoundingClientRect()
    if (!rect) return { cx: 0, cy: 0 }
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 }
  }, [])

  const apply = useCallback((s: number, tx: number, ty: number) => {
    const ns = clamp(s, MIN_SCALE, MAX_SCALE)
    scaleRef.current = ns
    txRef.current = ns <= 1 ? 0 : tx
    tyRef.current = ns <= 1 ? 0 : ty

    // 显示缩放倍率并重置自动隐藏计时器
    if (ns > 1) {
      setShowZoomBadge(true)
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
      zoomTimerRef.current = setTimeout(() => setShowZoomBadge(false), 1500)
    } else {
      setShowZoomBadge(false)
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
    }

    rerender()
  }, [rerender])

  // ====== 滚轮缩放 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      if (compareMode) return
      e.preventDefault()
      const s = scaleRef.current
      const tx = txRef.current
      const ty = tyRef.current
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left - rect.width / 2
      const my = e.clientY - rect.top - rect.height / 2

      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE)
      const r = ns / s
      apply(ns, mx - r * (mx - tx), my - r * (my - ty))
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [apply, compareMode])

  // ====== 鼠标拖拽 + 点击关闭 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      didDragRef.current = false
      if (scaleRef.current <= 1) return
      e.preventDefault()
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        baseTx: txRef.current,
        baseTy: tyRef.current,
      }
    }

    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d.active) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true
      apply(scaleRef.current, d.baseTx + dx, d.baseTy + dy)
    }

    const onUp = () => {
      dragRef.current.active = false
    }

    el.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [apply])

  // ====== 单击关闭（仅未缩放且非拖拽） ======
  const onClick = useCallback((e: React.MouseEvent) => {
    if (compareMode) return
    if (isLightboxControl(e.target)) return
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      e.stopPropagation()
      return
    }
    if (didDragRef.current) return
    if (scaleRef.current > 1 && e.target instanceof HTMLImageElement) return
    onClose()
  }, [compareMode, onClose])

  // ====== 鼠标双击缩放 ======
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if (compareMode) return
    if (isLightboxControl(e.target)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (Date.now() < suppressDoubleClickZoomUntilRef.current) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    e.stopPropagation()
    if (scaleRef.current > 1) {
      apply(1, 0, 0)
    } else {
      const { cx, cy } = getCenter()
      const mx = e.clientX - cx
      const my = e.clientY - cy
      apply(3, -mx * 2, -my * 2)
    }
  }, [apply, compareMode, getCenter])

  // ====== 触控事件 ======
  useEffect(() => {
    const el = containerRef.current
    if (!el || compareMode) return

    const clearCloseTapTimer = () => {
      if (closeTapTimerRef.current) {
        clearTimeout(closeTapTimerRef.current)
        closeTapTimerRef.current = null
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      clearCloseTapTimer()

      if (isLightboxControl(e.target)) {
        tapRef.current = { time: 0, x: 0, y: 0 }
        touchStartedOnImageRef.current = false
        return
      }

      if (e.touches.length === 2) {
        e.preventDefault()
        hadMultiTouchRef.current = true
        tapRef.current = { time: 0, x: 0, y: 0 }
        const [a, b] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const { cx, cy } = getCenter()
        pinchRef.current = {
          active: true,
          startDist: dist,
          startScale: scaleRef.current,
          startTx: txRef.current,
          startTy: tyRef.current,
          midX: (a.clientX + b.clientX) / 2 - cx,
          midY: (a.clientY + b.clientY) / 2 - cy,
        }
        dragRef.current.active = false
      } else if (e.touches.length === 1) {
        const t = e.touches[0]
        const now = Date.now()
        const prev = tapRef.current
        touchStartedOnImageRef.current = isLightboxSwipeTarget(e.target)
        didNavSwipeRef.current = false

        // 双击检测
        if (
          now - prev.time < 300 &&
          Math.abs(t.clientX - prev.x) < 30 &&
          Math.abs(t.clientY - prev.y) < 30
        ) {
          e.preventDefault()
          if (scaleRef.current > 1) {
            apply(1, 0, 0)
          } else {
            const { cx, cy } = getCenter()
            const mx = t.clientX - cx
            const my = t.clientY - cy
            apply(3, -mx * 2, -my * 2)
          }
          tapRef.current = { time: 0, x: 0, y: 0 }
          return
        }
        tapRef.current = { time: now, x: t.clientX, y: t.clientY }

        if (scaleRef.current > 1 && touchStartedOnImageRef.current) {
          e.preventDefault()
          dragRef.current = {
            active: true,
            startX: t.clientX,
            startY: t.clientY,
            baseTx: txRef.current,
            baseTy: tyRef.current,
          }
        }
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (pinchRef.current.active && e.touches.length === 2) {
        e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const p = pinchRef.current
        const ns = clamp(p.startScale * (dist / p.startDist), MIN_SCALE, MAX_SCALE)
        const r = ns / p.startScale
        apply(ns, p.midX - r * (p.midX - p.startTx), p.midY - r * (p.midY - p.startTy))
      } else if (dragRef.current.active && e.touches.length === 1) {
        e.preventDefault()
        const t = e.touches[0]
        const d = dragRef.current
        apply(scaleRef.current, d.baseTx + t.clientX - d.startX, d.baseTy + t.clientY - d.startY)
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (isLightboxControl(e.target)) {
        tapRef.current = { time: 0, x: 0, y: 0 }
        return
      }

      if (e.touches.length < 2) pinchRef.current.active = false
      if (e.touches.length === 0) {
        dragRef.current.active = false

        const endTouch = e.changedTouches[0]
        const start = tapRef.current
        const totalDeltaX = endTouch ? endTouch.clientX - start.x : 0
        const totalDeltaY = endTouch ? endTouch.clientY - start.y : 0
        const tapLike = isTouchTapLike(totalDeltaX, totalDeltaY)

        if (hadMultiTouchRef.current) {
          hadMultiTouchRef.current = false
          tapRef.current = { time: 0, x: 0, y: 0 }
          return
        }

        if (didNavSwipeRef.current) {
          suppressNextClickRef.current = true
          tapRef.current = { time: 0, x: 0, y: 0 }
          return
        }

        // 单击关闭：未缩放时点击图片外关闭；有明显位移时不触发。
        if (!tapLike) {
          tapRef.current = { time: 0, x: 0, y: 0 }
          return
        }
        if (scaleRef.current <= 1 && touchStartedOnImageRef.current) {
          tapRef.current = { time: 0, x: 0, y: 0 }
          return
        }
        if (scaleRef.current <= 1 || !touchStartedOnImageRef.current) {
          const prev = tapRef.current
          if (prev.time > 0 && Date.now() - prev.time < 300) {
            clearCloseTapTimer()
            closeTapTimerRef.current = setTimeout(() => {
              closeTapTimerRef.current = null
              if (tapRef.current.time === prev.time) {
                onClose()
              }
            }, 310)
          }
        }
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    return () => {
      clearCloseTapTimer()
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [apply, compareMode, getCenter, onClose])

  // 键盘左右切换（与箭头共用轮播补间动画）
  useEffect(() => {
    if (!showNav || compareMode) return
    const onKey = (e: KeyboardEvent) => {
      if (scaleRef.current > 1) return
      if (e.key === 'ArrowLeft' && canGoPrev) {
        e.preventDefault()
        handleNavPrev()
      }
      if (e.key === 'ArrowRight' && canGoNext) {
        e.preventDefault()
        handleNavNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canGoNext, canGoPrev, compareMode, handleNavNext, handleNavPrev, showNav])

  const s = scaleRef.current
  const tx = txRef.current
  const ty = tyRef.current
  const isZoomed = s > 1
  const isDragging = dragRef.current.active || pinchRef.current.active
  const updateLightboxNavAnchor = useCallback(() => {
    const panel = carouselPanelRef.current
    if (!panel || !showNav || isZoomed) {
      setLightboxNavAnchor(null)
      return
    }
    // 补间期间保留上一帧锚点，避免箭头闪烁
    if (carouselNavState.isDragging) {
      return
    }
    const img = panel.querySelector(
      'img.saveable-image[data-lightbox-active="true"]',
    ) as HTMLImageElement | null
    if (!img) {
      setLightboxNavAnchor(null)
      return
    }

    const computed = resolveLightboxDisplayRect(img)
    if (!computed) {
      setLightboxNavAnchor(null)
      return
    }

    const nav = resolveLightboxNavButtonPositions(computed)
    setLightboxNavAnchor({
      prevX: nav.prevLeft,
      prevY: nav.prevTop,
      nextX: nav.nextLeft,
      nextY: nav.nextTop,
    })
  }, [carouselNavState.isDragging, isZoomed, showNav])

  useLayoutEffect(() => {
    updateLightboxNavAnchor()
  }, [updateLightboxNavAnchor, carouselNavState.isDragging, carouselNavState.panelWidth, currentIndex, imageId, s, tx, ty])

  useEffect(() => {
    const panel = carouselPanelRef.current
    if (!panel) return
    const observer = new ResizeObserver(() => updateLightboxNavAnchor())
    observer.observe(panel)
    const onLoad = () => {
      window.requestAnimationFrame(() => updateLightboxNavAnchor())
    }
    panel.addEventListener('load', onLoad, true)
    window.addEventListener('resize', updateLightboxNavAnchor)
    return () => {
      observer.disconnect()
      panel.removeEventListener('load', onLoad, true)
      window.removeEventListener('resize', updateLightboxNavAnchor)
    }
  }, [updateLightboxNavAnchor])

  useEffect(() => {
    const wrap = carouselWrapRef.current
    if (!wrap) return
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.animationName !== 'zoom-in') return
      updateLightboxNavAnchor()
    }
    wrap.addEventListener('animationend', onAnimationEnd)
    return () => wrap.removeEventListener('animationend', onAnimationEnd)
  }, [updateLightboxNavAnchor, imageId])

  const showLightboxNav = showNav && !isZoomed && !compareMode && lightboxNavAnchor
  const zoomTransform = `translate(${tx}px, ${ty}px) scale(${s})`
  const zoomTransition = isDragging ? 'none' : 'transform 0.2s ease-out'
  const zoomPercent = Math.round(s * 100)

  return (
    <div
      ref={containerRef}
      data-lightbox-root
      className="fixed inset-0 z-[60] flex items-center justify-center select-none"
      style={{
        cursor: isZoomed ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
        touchAction: 'none',
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="glass-overlay absolute inset-0 animate-fade-in" />
      <div className="lightbox-control-top-actions absolute z-20 flex items-center gap-2">
        {canCompare ? (
          <button
            type="button"
            data-lightbox-control
            className={`rounded-full px-4 py-2 text-sm text-white backdrop-blur-sm transition ${
              compareMode
                ? 'bg-white/25 ring-1 ring-white/40 hover:bg-white/30'
                : 'bg-black/45 hover:bg-black/65'
            }`}
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              setCompareMode((value) => !value)
            }}
            onDoubleClick={stopControlDoubleClick}
          >
            {compareMode ? '退出对比' : '对比'}
          </button>
        ) : null}
        <button
          type="button"
          data-lightbox-control
          className="rounded-full bg-black/45 px-4 py-2 text-sm text-white backdrop-blur-sm transition hover:bg-black/65"
          onPointerDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
          onDoubleClick={stopControlDoubleClick}
        >
          {isReferenceImage ? '高级编辑' : '高级编辑并加入参考图'}
        </button>
      </div>
      <div
        ref={carouselWrapRef}
        className="pointer-events-auto relative flex h-[100dvh] w-[100vw] items-center justify-center animate-zoom-in"
      >
        {compareMode && compareTarget ? (
          <LightboxImageCompare
            primarySrc={primarySrc}
            compareSrc={compareSrc}
            primaryLabel={compareTarget.primaryLabel}
            compareLabel={compareTarget.compareLabel}
          />
        ) : (
          <LightboxImageCarousel
            ref={carouselRef}
            imageIds={imageIds.length > 0 ? imageIds : [imageId]}
            currentIndex={currentIndex >= 0 ? currentIndex : 0}
            maskPreviewSrc={maskPreviewSrc}
            zoomTransform={zoomTransform}
            zoomTransition={zoomTransition}
            swipeEnabled={showNav && !isZoomed}
            onIndexChangeRequest={onGoToIndex}
            onNavStateChange={setCarouselNavState}
            onSwipeGesture={handleCarouselSwipeGesture}
            carouselPanelRef={carouselPanelRef}
          />
        )}
      </div>

      {showLightboxNav ? (
        <>
          {canGoPrev ? (
            <button
              type="button"
              data-lightbox-control
              className={lightboxNavBtnClass}
              style={{
                left: lightboxNavAnchor.prevX,
                top: lightboxNavAnchor.prevY,
              }}
              aria-label="上一张"
              onPointerDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
              onTouchEnd={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                handleNavPrev()
              }}
              onDoubleClick={stopControlDoubleClick}
            >
              <svg className="h-5 w-5 sm:h-6 sm:w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          ) : null}
          {canGoNext ? (
            <button
              type="button"
              data-lightbox-control
              className={lightboxNavBtnClass}
              style={{
                left: lightboxNavAnchor.nextX,
                top: lightboxNavAnchor.nextY,
              }}
              aria-label="下一张"
              onPointerDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
              onTouchEnd={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                handleNavNext()
              }}
              onDoubleClick={stopControlDoubleClick}
            >
              <svg className="h-5 w-5 sm:h-6 sm:w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : null}
        </>
      ) : null}

      {/* 底部指示器 */}
      {showZoomBadge && isZoomed && zoomPercent !== 100 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
          <span className="px-3 py-1.5 bg-black/50 text-white/80 text-xs rounded-full backdrop-blur-sm transition-opacity duration-500">
            {zoomPercent}%
          </span>
        </div>
      )}
      {showNav && !isZoomed && !compareMode && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
          <span className="px-3 py-1.5 bg-black/50 text-white/80 text-xs rounded-full backdrop-blur-sm">
            {currentIndex + 1} / {total}
          </span>
        </div>
      )}
    </div>
  )
}
