import { useEffect, useRef, useState } from 'react'

const VIDEO_PLAYER_VOLUME_STORAGE_KEY = 'gpt-image-playground-video-volume'
const VIDEO_SEEK_STEP_SECONDS = 5
const VIDEO_SEEK_SWIPE_RANGE_SECONDS = 24
const VIDEO_TOUCH_DOUBLE_TAP_MS = 280
const VIDEO_TOUCH_GESTURE_LOCK_PX = 12
const VIDEO_TOUCH_TAP_MAX_MOVE_PX = 10
const VIDEO_VOLUME_WHEEL_STEP = 0.05
const VIDEO_FEEDBACK_HIDE_MS = 900
const VIDEO_VOLUME_CURVE_POWER = 2

interface VideoPlayerProps {
  src: string
  poster?: string
  nativeControls?: boolean
  blurred?: boolean
}

function formatVideoTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const totalSeconds = Math.floor(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const remainSeconds = totalSeconds % 60
  return `${minutes}:${String(remainSeconds).padStart(2, '0')}`
}

function volumeToSliderValue(volume: number) {
  return Math.sqrt(Math.max(0, Math.min(1, volume)))
}

function sliderValueToVolume(value: number) {
  return Math.min(1, Math.max(0, value)) ** VIDEO_VOLUME_CURVE_POWER
}

export default function VideoPlayer({ src, poster, nativeControls = false, blurred = false }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const volumeGroupRef = useRef<HTMLDivElement>(null)
  const volumeHideTimerRef = useRef<number | null>(null)
  const feedbackHideTimerRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioGainRef = useRef<GainNode | null>(null)
  const audioSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null)
  const lastTouchTapAtRef = useRef(0)
  const suppressMouseClickUntilRef = useRef(0)
  const touchGestureRef = useRef<{
    startX: number
    startY: number
    startTime: number
    startVolume: number
    startCurrentTime: number
    pointerId: number
    rightHalf: boolean
    mode: 'pending' | 'seek' | 'volume'
    moved: boolean
  } | null>(null)
  const previousVolumeRef = useRef(1)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [hasEnded, setHasEnded] = useState(false)
  const [isViewportFullscreen, setIsViewportFullscreen] = useState(false)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [isVolumePinned, setIsVolumePinned] = useState(false)
  const [isVolumeHovered, setIsVolumeHovered] = useState(false)
  const [feedbackState, setFeedbackState] = useState<null | { type: 'play' | 'pause' | 'volume'; label: string }>(null)
  const shouldShowPosterOverlay = Boolean(poster) && !isPlaying && (hasEnded || currentTime <= 0.05)
  const isIosBrowser = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent || '')

  useEffect(() => {
    if (typeof window === 'undefined') return

    const savedVolume = window.localStorage.getItem(VIDEO_PLAYER_VOLUME_STORAGE_KEY)
    const parsedVolume = savedVolume == null ? 1 : Number(savedVolume)
    if (!Number.isFinite(parsedVolume)) return
    const nextVolume = Math.min(1, Math.max(0, parsedVolume))
    setVolume(nextVolume)
    setIsMuted(nextVolume === 0)
    if (nextVolume > 0) previousVolumeRef.current = nextVolume
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.defaultMuted = false
    video.volume = isIosBrowser ? 1 : volume
    video.muted = isIosBrowser ? false : (isMuted || volume <= 0)
    video.setAttribute('playsinline', 'true')
    video.setAttribute('webkit-playsinline', 'true')

    const syncDuration = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0)
    const syncTime = () => setCurrentTime(video.currentTime || 0)
    const syncPlay = () => {
      setIsPlaying(!video.paused && !video.ended)
      setHasEnded(false)
    }
    const syncPause = () => setIsPlaying(false)
    const syncEnded = () => {
      setIsPlaying(false)
      setHasEnded(true)
      try {
        video.currentTime = 0
        setCurrentTime(0)
      } catch {
        /* 忽略当前时间回写失败 */
      }
    }
    const syncVolume = () => {
      if (isIosBrowser) return
      const nextVolume = Number.isFinite(video.volume) ? video.volume : 1
      setVolume(nextVolume)
      setIsMuted(video.muted || nextVolume <= 0)
      if (!video.muted && nextVolume > 0) previousVolumeRef.current = nextVolume
    }

    syncDuration()
    syncTime()
    syncPlay()
    if (!isIosBrowser) {
      syncVolume()
    }

    video.addEventListener('loadedmetadata', syncDuration)
    video.addEventListener('durationchange', syncDuration)
    video.addEventListener('timeupdate', syncTime)
    video.addEventListener('play', syncPlay)
    video.addEventListener('pause', syncPause)
    video.addEventListener('ended', syncEnded)
    video.addEventListener('volumechange', syncVolume)

    return () => {
      video.pause()
      video.removeEventListener('loadedmetadata', syncDuration)
      video.removeEventListener('durationchange', syncDuration)
      video.removeEventListener('timeupdate', syncTime)
      video.removeEventListener('play', syncPlay)
      video.removeEventListener('pause', syncPause)
      video.removeEventListener('ended', syncEnded)
      video.removeEventListener('volumechange', syncVolume)
    }
  }, [isIosBrowser, src])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (isIosBrowser && audioGainRef.current) {
      audioGainRef.current.gain.value = isMuted ? 0 : volume
      return
    }
    video.volume = volume
    video.muted = isMuted || volume <= 0
  }, [isIosBrowser, isMuted, volume])

  useEffect(() => {
    return () => {
      audioSourceNodeRef.current?.disconnect()
      audioGainRef.current?.disconnect()
      void audioContextRef.current?.close()
      audioSourceNodeRef.current = null
      audioGainRef.current = null
      audioContextRef.current = null
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(VIDEO_PLAYER_VOLUME_STORAGE_KEY, String(volume))
  }, [volume])

  useEffect(() => {
    if (typeof document === 'undefined') return

    const handlePointerDown = (event: PointerEvent) => {
      const volumeGroup = volumeGroupRef.current
      if (!volumeGroup) return
      if (volumeGroup.contains(event.target as Node)) return
      setIsVolumePinned(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && volumeHideTimerRef.current != null) {
        window.clearTimeout(volumeHideTimerRef.current)
      }
      if (typeof window !== 'undefined' && feedbackHideTimerRef.current != null) {
        window.clearTimeout(feedbackHideTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!isViewportFullscreen) return

    const previousOverflow = document.body.style.overflow
    const hadNoBackdropFilterClass = document.body.classList.contains('no-backdrop-filter')
    document.body.style.overflow = 'hidden'
    document.body.classList.add('video-player-fullscreen-active')
    if (!hadNoBackdropFilterClass) {
      document.body.classList.add('no-backdrop-filter')
    }

    return () => {
      document.body.style.overflow = previousOverflow
      document.body.classList.remove('video-player-fullscreen-active')
      if (!hadNoBackdropFilterClass) {
        document.body.classList.remove('no-backdrop-filter')
      }
    }
  }, [isViewportFullscreen])

  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!isViewportFullscreen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setIsViewportFullscreen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isViewportFullscreen])

  const showFeedback = (type: 'play' | 'pause' | 'volume', label: string) => {
    setFeedbackState({ type, label })
    if (typeof window === 'undefined') return
    if (feedbackHideTimerRef.current != null) {
      window.clearTimeout(feedbackHideTimerRef.current)
    }
    feedbackHideTimerRef.current = window.setTimeout(() => {
      setFeedbackState(null)
      feedbackHideTimerRef.current = null
    }, VIDEO_FEEDBACK_HIDE_MS)
  }

  const ensureIosAudioGraphReady = async () => {
    if (!isIosBrowser || typeof window === 'undefined') return

    const video = videoRef.current
    if (!video) return

    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextCtor()
    }

    if (!audioGainRef.current) {
      audioGainRef.current = audioContextRef.current.createGain()
      audioGainRef.current.connect(audioContextRef.current.destination)
    }

    if (!audioSourceNodeRef.current) {
      audioSourceNodeRef.current = audioContextRef.current.createMediaElementSource(video)
      audioSourceNodeRef.current.connect(audioGainRef.current)
    }

    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume()
    }

    audioGainRef.current.gain.value = isMuted ? 0 : volume
    video.volume = 1
    video.muted = false
  }

  const togglePlay = async () => {
    const video = videoRef.current
    if (!video) return

    if (video.paused || video.ended) {
      await ensureIosAudioGraphReady()
      if (video.ended || hasEnded) {
        try {
          video.currentTime = 0
          setCurrentTime(0)
        } catch {
          /* 忽略当前时间回写失败 */
        }
      }
      try {
        await video.play()
        showFeedback('play', '播放')
      } catch {
        setIsPlaying(false)
      }
      return
    }

    video.pause()
    showFeedback('pause', '暂停')
  }

  const handleSeek = (value: string) => {
    const video = videoRef.current
    const nextTime = Number(value)
    if (!video || Number.isNaN(nextTime)) return
    video.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const handleVolumeChange = (value: string, options?: { silent?: boolean }) => {
    const video = videoRef.current
    const nextVolume = Number(value)
    if (!video || Number.isNaN(nextVolume)) return
    const normalizedVolume = Math.min(1, Math.max(0, nextVolume))
    suppressMouseClickUntilRef.current = Date.now() + 500
    void ensureIosAudioGraphReady()
    if (!isIosBrowser) {
      video.volume = normalizedVolume
      video.muted = normalizedVolume <= 0
    }
    setVolume(normalizedVolume)
    setIsMuted(normalizedVolume <= 0)
    if (normalizedVolume > 0) previousVolumeRef.current = normalizedVolume
    if (!options?.silent) {
      showFeedback('volume', `音量 ${Math.round(normalizedVolume * 100)}%`)
    }
  }

  const toggleMute = () => {
    const video = videoRef.current
    if (!video) return
    void ensureIosAudioGraphReady()

    if ((isIosBrowser ? isMuted : video.muted) || volume <= 0) {
      const restoredVolume = previousVolumeRef.current > 0 ? previousVolumeRef.current : 1
      suppressMouseClickUntilRef.current = Date.now() + 500
      if (!isIosBrowser) {
        video.volume = restoredVolume
        video.muted = false
      }
      setVolume(restoredVolume)
      setIsMuted(false)
      showFeedback('volume', `音量 ${Math.round(restoredVolume * 100)}%`)
      return
    }

    if (volume > 0) previousVolumeRef.current = volume
    suppressMouseClickUntilRef.current = Date.now() + 500
    if (!isIosBrowser) {
      video.muted = true
    }
    setIsMuted(true)
    showFeedback('volume', '静音')
  }

  const handleVolumeButtonClick = () => {
    if (!isVolumePinned && !isVolumeHovered) {
      setIsVolumePinned(true)
      return
    }

    toggleMute()
  }

  const clearVolumeHideTimer = () => {
    if (typeof window === 'undefined' || volumeHideTimerRef.current == null) return
    window.clearTimeout(volumeHideTimerRef.current)
    volumeHideTimerRef.current = null
  }

  const handleVolumeMouseEnter = () => {
    clearVolumeHideTimer()
    setIsVolumeHovered(true)
  }

  const handleVolumeMouseLeave = () => {
    if (typeof window === 'undefined') return
    clearVolumeHideTimer()
    volumeHideTimerRef.current = window.setTimeout(() => {
      setIsVolumeHovered(false)
      volumeHideTimerRef.current = null
    }, 120)
  }

  const showVolumeSlider = isVolumePinned || isVolumeHovered
  const sliderVolume = isMuted ? 0 : volume

  const volumeIcon = isMuted || volume <= 0
    ? 'muted'
    : volume < 0.5
      ? 'low'
      : 'high'

  const toggleFullscreen = () => {
    setIsViewportFullscreen((prev) => !prev)
  }

  const handleSeekByDelta = (deltaSeconds: number) => {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return
    const nextTime = Math.max(0, Math.min(video.duration, (video.currentTime || 0) + deltaSeconds))
    video.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const handleKeyboardControl = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (nativeControls) return
    if (event.target instanceof HTMLElement && event.target.closest('.detail-video-controls')) return

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      handleSeekByDelta(-VIDEO_SEEK_STEP_SECONDS)
      return
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      handleSeekByDelta(VIDEO_SEEK_STEP_SECONDS)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      handleVolumeChange(String((isMuted ? 0 : volume) + VIDEO_VOLUME_WHEEL_STEP))
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      handleVolumeChange(String((isMuted ? 0 : volume) - VIDEO_VOLUME_WHEEL_STEP))
    }
  }

  const handleWheelVolume = (event: React.WheelEvent<HTMLDivElement>) => {
    if (nativeControls) return
    if (event.target instanceof HTMLElement && event.target.closest('.detail-video-controls')) return
    event.preventDefault()
    const delta = event.deltaY < 0 ? VIDEO_VOLUME_WHEEL_STEP : -VIDEO_VOLUME_WHEEL_STEP
    handleVolumeChange(String((isMuted ? 0 : volume) + delta))
  }

  const handleMouseToggle = (event: React.MouseEvent<HTMLDivElement>) => {
    if (nativeControls) return
    if (event.target instanceof HTMLElement && event.target.closest('.detail-video-controls')) return
    if (Date.now() < suppressMouseClickUntilRef.current) return
    if (event.detail !== 1) return
    void togglePlay()
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (nativeControls) return
    playerRef.current?.focus()
    if (event.pointerType !== 'touch') return
    if (event.target instanceof HTMLElement && event.target.closest('.detail-video-controls')) return

    const player = playerRef.current
    if (!player) return
    const rect = player.getBoundingClientRect()
    touchGestureRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startTime: Date.now(),
      startVolume: isMuted ? 0 : volume,
      startCurrentTime: videoRef.current?.currentTime || 0,
      pointerId: event.pointerId,
      rightHalf: event.clientX >= rect.left + rect.width / 2,
      mode: 'pending',
      moved: false,
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (nativeControls) return
    const gesture = touchGestureRef.current
    const player = playerRef.current
    if (!gesture || !player || gesture.pointerId !== event.pointerId) return
    if (event.target instanceof HTMLElement && event.target.closest('.detail-video-controls')) return

    const rect = player.getBoundingClientRect()
    const deltaX = event.clientX - gesture.startX
    const deltaY = event.clientY - gesture.startY
    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)

    if (gesture.mode === 'pending') {
      if (absX < VIDEO_TOUCH_GESTURE_LOCK_PX && absY < VIDEO_TOUCH_GESTURE_LOCK_PX) return
      gesture.mode = gesture.rightHalf && absY > absX ? 'volume' : 'seek'
      gesture.moved = true
    }

    if (gesture.mode === 'volume') {
      event.preventDefault()
      const range = Math.max(rect.height, 1)
      const nextVolume = sliderValueToVolume(volumeToSliderValue(gesture.startVolume) - deltaY / range)
      handleVolumeChange(String(nextVolume))
      gesture.moved = true
      return
    }

    if (gesture.mode === 'seek') {
      const video = videoRef.current
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return
      event.preventDefault()
      const range = Math.max(rect.width, 1)
      const deltaSeconds = (deltaX / range) * VIDEO_SEEK_SWIPE_RANGE_SECONDS
      const nextTime = Math.max(0, Math.min(video.duration, gesture.startCurrentTime + deltaSeconds))
      video.currentTime = nextTime
      setCurrentTime(nextTime)
      gesture.moved = true
    }
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (nativeControls) return
    const gesture = touchGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    touchGestureRef.current = null
    if (event.target instanceof HTMLElement && event.target.closest('.detail-video-controls')) return

    if (gesture.moved || gesture.mode !== 'pending') {
      suppressMouseClickUntilRef.current = Date.now() + 500
      return
    }

    const deltaX = Math.abs(event.clientX - gesture.startX)
    const deltaY = Math.abs(event.clientY - gesture.startY)
    const isTap = !gesture.moved && deltaX <= VIDEO_TOUCH_TAP_MAX_MOVE_PX && deltaY <= VIDEO_TOUCH_TAP_MAX_MOVE_PX
    if (!isTap) return

    const now = Date.now()
    if (shouldShowPosterOverlay && currentTime <= 0.05) {
      lastTouchTapAtRef.current = 0
      suppressMouseClickUntilRef.current = now + 400
      void togglePlay()
      return
    }
    if (now - lastTouchTapAtRef.current <= VIDEO_TOUCH_DOUBLE_TAP_MS) {
      lastTouchTapAtRef.current = 0
      suppressMouseClickUntilRef.current = now + 400
      void togglePlay()
      return
    }
    lastTouchTapAtRef.current = now
    suppressMouseClickUntilRef.current = now + 400
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = touchGestureRef.current
    if (gesture?.pointerId === event.pointerId) {
      touchGestureRef.current = null
    }
  }

  return (
    <div
      ref={playerRef}
      className={`detail-video-player${isViewportFullscreen ? ' detail-video-player-viewport-fullscreen' : ''}`}
      tabIndex={nativeControls ? -1 : 0}
      onKeyDown={handleKeyboardControl}
      onClick={handleMouseToggle}
      onMouseDown={() => playerRef.current?.focus()}
      onWheel={handleWheelVolume}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        playsInline
        controls={nativeControls}
        preload="metadata"
        className={`detail-video-element${nativeControls ? ' detail-video-element-native' : ''}${shouldShowPosterOverlay && !nativeControls ? ' detail-video-element-hidden' : ''}${blurred ? ' blur-md scale-[1.02]' : ''}`}
      />
      {shouldShowPosterOverlay && (
        nativeControls ? (
          <img
            src={poster}
            alt=""
            className={`pointer-events-none absolute inset-0 h-full w-full object-contain${blurred ? ' blur-md scale-[1.02]' : ''}`}
          />
        ) : (
          <div className="detail-video-poster-button" aria-hidden="true">
            <img
              src={poster}
              alt=""
              className={`h-full w-full object-contain${blurred ? ' blur-md scale-[1.02]' : ''}`}
            />
            <span className="detail-video-poster-play-icon" aria-hidden="true">
              <svg className="ml-0.5 h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5.14v13.72c0 .72.78 1.17 1.4.82l10.54-6.86a.94.94 0 000-1.64L9.4 4.32A.95.95 0 008 5.14z" />
              </svg>
            </span>
          </div>
        )
      )}
      {feedbackState && !nativeControls && (
        feedbackState.type === 'volume' ? (
          <div className={`detail-video-volume-feedback${isViewportFullscreen ? '' : ' detail-video-volume-feedback-compact'}`} aria-hidden="true">
            <div className="detail-video-volume-feedback-shell">
              <div className="detail-video-volume-feedback-track">
                <div
                  className="detail-video-volume-feedback-fill"
                  style={{ height: `${Math.max(0, Math.min(100, Math.round((isMuted ? 0 : volume) * 100)))}%` }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="detail-video-feedback" aria-hidden="true">
            <div className={`detail-video-feedback-icon${isViewportFullscreen ? '' : ' detail-video-feedback-icon-compact'}`}>
              {feedbackState.type === 'play' ? (
                <svg className="ml-0.5 h-7 w-7" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5.14v13.72c0 .72.78 1.17 1.4.82l10.54-6.86a.94.94 0 000-1.64L9.4 4.32A.95.95 0 008 5.14z" />
                </svg>
              ) : (
                <svg className="h-7 w-7" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 5h3v14H7zm7 0h3v14h-3z" />
                </svg>
              )}
            </div>
          </div>
        )
      )}
      {blurred && <div className="pointer-events-none absolute inset-0 bg-black/20" />}
      {!nativeControls && (
        <div
          className="detail-video-controls"
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => void togglePlay()}
            className="detail-video-play-button"
            aria-label={isPlaying ? '暂停视频' : '播放视频'}
          >
            {isPlaying ? (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7 5h3v14H7zm7 0h3v14h-3z" />
              </svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5.14v13.72c0 .72.78 1.17 1.4.82l10.54-6.86a.94.94 0 000-1.64L9.4 4.32A.95.95 0 008 5.14z" />
              </svg>
            )}
          </button>
          <div
            ref={volumeGroupRef}
            className="detail-video-volume-group"
            onMouseEnter={handleVolumeMouseEnter}
            onMouseLeave={handleVolumeMouseLeave}
          >
            {showVolumeSlider && (
              <div
                className="detail-video-volume-popover"
                onMouseEnter={handleVolumeMouseEnter}
                onMouseLeave={handleVolumeMouseLeave}
              >
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sliderVolume}
                  onChange={(event) => handleVolumeChange(event.target.value)}
                  onInput={(event) => handleVolumeChange(event.currentTarget.value)}
                  className="detail-video-volume detail-video-volume-vertical"
                  aria-label="视频音量"
                />
              </div>
            )}
            <button
              type="button"
              onClick={handleVolumeButtonClick}
              className="detail-video-volume-button"
              aria-label={showVolumeSlider ? (isMuted || volume <= 0 ? '恢复声音' : '静音') : '展开音量调节'}
            >
              {volumeIcon === 'muted' ? (
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M11 5 6 9H3v6h3l5 4z" />
                  <path d="m17 9 4 6" />
                  <path d="m21 9-4 6" />
                </svg>
              ) : volumeIcon === 'low' ? (
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M11 5 6 9H3v6h3l5 4z" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                </svg>
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M11 5 6 9H3v6h3l5 4z" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  <path d="M18.5 6a9 9 0 0 1 0 12" />
                </svg>
              )}
            </button>
          </div>
          <span className="detail-video-time" aria-hidden="true">
            {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(event) => handleSeek(event.target.value)}
            onInput={(event) => handleSeek(event.currentTarget.value)}
            className="detail-video-progress"
            aria-label="视频播放进度"
          />
          <button
            type="button"
            onClick={toggleFullscreen}
            className="detail-video-fullscreen-button"
            aria-label={isViewportFullscreen ? '退出全屏' : '进入全屏'}
          >
            {isViewportFullscreen ? (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
              </svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
