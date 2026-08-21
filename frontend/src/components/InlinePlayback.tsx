import { useEffect, useRef, useState } from 'react'
import { formatDuration } from '../utils/formatTranscription'
import { PauseIcon, PlayIcon } from '../ui/icons'

// Same markup/classes as the report's "Original audio playback" control
// (App.css .playback-controls) -- a native <audio controls> element ignores
// the design entirely and renders the browser's own default player chrome.
// Shared by uploads (local blob URL) and YouTube (signed URL to the
// extracted audio the worker publishes) -- one real audio player, not a
// video embed.
export default function InlinePlayback({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const audio = new Audio(src)
    audioRef.current = audio
    audio.addEventListener('loadedmetadata', () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0))
    audio.addEventListener('ended', () => setIsPlaying(false))
    return () => { audio.pause(); audioRef.current = null }
  }, [src])

  useEffect(() => {
    const update = () => {
      if (!audioRef.current || !isPlaying) return
      setCurrentTime(audioRef.current.currentTime)
      frameRef.current = requestAnimationFrame(update)
    }
    if (isPlaying) frameRef.current = requestAnimationFrame(update)
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }
  }, [isPlaying])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (isPlaying) { audio.pause(); setIsPlaying(false) } else { void audio.play(); setIsPlaying(true) }
  }

  const seek = (value: number) => {
    if (audioRef.current) audioRef.current.currentTime = value
    setCurrentTime(value)
  }

  return (
    <div className="playback-controls">
      <button
        type="button"
        className="icon-btn"
        onClick={toggle}
        aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
        title={isPlaying ? 'Pause audio' : 'Play audio'}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="playback-time">
        <span>{formatDuration(currentTime)}</span>
        <span>{formatDuration(duration)}</span>
      </div>
      <input
        type="range"
        min="0"
        max={Math.max(duration, 0.01)}
        step="0.01"
        value={Math.min(currentTime, duration)}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label="Playback position"
      />
    </div>
  )
}
