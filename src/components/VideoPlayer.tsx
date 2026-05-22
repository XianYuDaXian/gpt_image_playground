import { useEffect, useRef, useState } from 'react'

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

export default function VideoPlayer({ src, poster, nativeControls = false, blurred = false }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.muted = false
    video.defaultMuted = false
    video.volume = 1
    video.setAttribute('playsinline', 'true')
    video.setAttribute('webkit-playsinline', 'true')

    const syncDuration = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0)
    const syncTime = () => setCurrentTime(video.currentTime || 0)
    const syncPlay = () => setIsPlaying(!video.paused && !video.ended)
    const syncPause = () => setIsPlaying(false)
    const syncEnded = () => setIsPlaying(false)

    syncDuration()
    syncTime()
    syncPlay()

    video.addEventListener('loadedmetadata', syncDuration)
    video.addEventListener('durationchange', syncDuration)
    video.addEventListener('timeupdate', syncTime)
    video.addEventListener('play', syncPlay)
    video.addEventListener('pause', syncPause)
    video.addEventListener('ended', syncEnded)

    return () => {
      video.pause()
      video.removeEventListener('loadedmetadata', syncDuration)
      video.removeEventListener('durationchange', syncDuration)
      video.removeEventListener('timeupdate', syncTime)
      video.removeEventListener('play', syncPlay)
      video.removeEventListener('pause', syncPause)
      video.removeEventListener('ended', syncEnded)
    }
  }, [src])

  useEffect(() => {
    if (typeof document === 'undefined') return

    const syncFullscreen = () => {
      const player = playerRef.current
      setIsFullscreen(Boolean(player && document.fullscreenElement === player))
    }

    document.addEventListener('fullscreenchange', syncFullscreen)
    return () => document.removeEventListener('fullscreenchange', syncFullscreen)
  }, [])

  const togglePlay = async () => {
    const video = videoRef.current
    if (!video) return

    if (video.paused || video.ended) {
      try {
        await video.play()
      } catch {
        setIsPlaying(false)
      }
      return
    }

    video.pause()
  }

  const handleSeek = (value: string) => {
    const video = videoRef.current
    const nextTime = Number(value)
    if (!video || Number.isNaN(nextTime)) return
    video.currentTime = nextTime
    setCurrentTime(nextTime)
  }

  const toggleFullscreen = async () => {
    const player = playerRef.current
    if (!player || typeof document === 'undefined') return

    if (document.fullscreenElement === player) {
      await document.exitFullscreen()
      return
    }

    if (player.requestFullscreen) {
      await player.requestFullscreen()
    }
  }

  return (
    <div ref={playerRef} className="detail-video-player">
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        playsInline
        controls={nativeControls}
        preload="metadata"
        className={`detail-video-element${nativeControls ? ' detail-video-element-native' : ''}${blurred ? ' blur-md scale-[1.02]' : ''}`}
      />
      {blurred && <div className="pointer-events-none absolute inset-0 bg-black/20" />}
      {!nativeControls && (
        <div
          className="detail-video-controls"
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
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
              <svg className="h-4 w-4 translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5.14v13.72c0 .72.78 1.17 1.4.82l10.54-6.86a.94.94 0 000-1.64L9.4 4.32A.95.95 0 008 5.14z" />
              </svg>
            )}
          </button>
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
            onClick={() => void toggleFullscreen()}
            className="detail-video-fullscreen-button"
            aria-label={isFullscreen ? '退出全屏' : '进入全屏'}
          >
            {isFullscreen ? (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M9 15H5v4" />
                <path d="M15 9h4V5" />
                <path d="M19 15v4h-4" />
                <path d="M5 9V5h4" />
              </svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
