import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

interface LightboxImageCompareProps {
  primarySrc: string
  compareSrc: string
  primaryLabel: string
  compareLabel: string
}

interface FrameSize {
  width: number
  height: number
}

const imageBoundsClass =
  'h-full w-full object-contain rounded-lg shadow-2xl'

const labelClass =
  'shrink-0 whitespace-nowrap rounded-full bg-black/65 px-2.5 py-1 text-[11px] leading-none text-white/95 backdrop-blur-sm'

function clampSplit(value: number) {
  return Math.max(4, Math.min(96, value))
}

export default function LightboxImageCompare({
  primarySrc,
  compareSrc,
  primaryLabel,
  compareLabel,
}: LightboxImageCompareProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const sizingRef = useRef<HTMLImageElement>(null)
  const frameSizeRef = useRef<FrameSize>({ width: 1, height: 1 })
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null)
  const [primaryReady, setPrimaryReady] = useState(false)
  const [splitPercent, setSplitPercent] = useState(50)
  const splitRef = useRef(50)
  const dragRef = useRef<{ active: boolean; startX: number; startSplit: number; regionWidth: number } | null>(null)

  const updateSplit = useCallback((next: number) => {
    const clamped = clampSplit(next)
    splitRef.current = clamped
    setSplitPercent(clamped)
  }, [])

  const syncFrameSize = useCallback(() => {
    const sizing = sizingRef.current
    if (!sizing) return
    const width = sizing.offsetWidth
    const height = sizing.offsetHeight
    if (width <= 0 || height <= 0) return
    frameSizeRef.current = { width, height }
    setFrameSize({ width, height })
  }, [])

  useEffect(() => {
    setPrimaryReady(false)
    setFrameSize(null)
  }, [primarySrc, compareSrc])

  useEffect(() => {
    const sizing = sizingRef.current
    if (!sizing) return

    syncFrameSize()
    const observer = new ResizeObserver(() => {
      syncFrameSize()
    })
    observer.observe(sizing)
    window.addEventListener('resize', syncFrameSize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncFrameSize)
    }
  }, [primaryReady, syncFrameSize])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!primaryReady || frameSizeRef.current.width <= 0) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startSplit: splitRef.current,
      regionWidth: frameSizeRef.current.width,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [primaryReady])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag?.active) return
    event.preventDefault()
    const deltaX = event.clientX - drag.startX
    updateSplit(drag.startSplit + (deltaX / drag.regionWidth) * 100)
  }, [updateSplit])

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag?.active) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const ready = primaryReady && frameSize && frameSize.width > 0 && frameSize.height > 0

  return (
    <div
      data-lightbox-compare
      className="pointer-events-auto relative flex h-[100dvh] w-[100vw] items-center justify-center px-2 sm:px-4"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex max-h-[90dvh] max-w-[min(92vw,100%)] flex-col items-center gap-2">
        {ready ? (
          <div
            className="flex w-full items-center justify-between gap-4 px-1"
            style={{ width: frameSize.width }}
          >
            <span className={labelClass}>{primaryLabel}</span>
            <span className={labelClass}>{compareLabel}</span>
          </div>
        ) : null}

        <div
          ref={frameRef}
          data-compare-image
          className="relative max-h-[90dvh] max-w-[min(92vw,100%)] cursor-ew-resize select-none touch-none"
          style={{
            width: frameSize?.width,
            height: frameSize?.height,
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
        >
          <img
            ref={sizingRef}
            src={primarySrc}
            alt=""
            draggable={false}
            className={`${ready ? 'absolute opacity-0' : ''} max-h-[90dvh] max-w-[min(92vw,100%)] object-contain pointer-events-none`}
            onLoad={() => {
              setPrimaryReady(true)
              syncFrameSize()
            }}
          />

          {!ready ? (
            <div className="flex h-40 w-40 items-center justify-center">
              <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
            </div>
          ) : (
            <>
              <img
                src={compareSrc}
                alt=""
                draggable={false}
                data-compare-image
                className={`pointer-events-none absolute inset-0 z-0 ${imageBoundsClass}`}
              />

              <div
                className="pointer-events-none absolute inset-y-0 left-0 z-[1] overflow-hidden"
                style={{ width: `${splitPercent}%` }}
              >
                <div className="relative h-full" style={{ width: frameSize.width }}>
                  <img
                    src={primarySrc}
                    alt=""
                    draggable={false}
                    className={`absolute inset-0 ${imageBoundsClass}`}
                  />
                </div>
              </div>

              <div
                data-compare-image
                className="pointer-events-none absolute top-0 z-30"
                style={{
                  left: `${splitPercent}%`,
                  height: frameSize.height,
                  width: 0,
                }}
              >
                <div
                  className="absolute left-1/2 top-0 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.55),0_0_10px_rgba(0,0,0,0.4)]"
                  style={{ width: 3, height: frameSize.height }}
                />
                <div className="absolute left-1/2 top-1/2 flex h-14 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-black/20 bg-white shadow-[0_4px_14px_rgba(0,0,0,0.35)]">
                  <div className="flex items-center gap-1.5">
                    <div className="h-5 w-[2px] rounded-full bg-black/50" />
                    <div className="h-5 w-[2px] rounded-full bg-black/50" />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2">
        <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs text-white/80 backdrop-blur-sm">
          在图上左右滑动对比
        </span>
      </div>
    </div>
  )
}