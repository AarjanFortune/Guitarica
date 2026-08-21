import { MouseEvent, useEffect, useRef, useState } from 'react'
import { getLocalAudio, saveAudioLocally } from '../services/audioCache'
import { TranscribedNote, TranscriptionResult } from '../types/transcription'
import { formatBytes, formatDuration, formatTempo } from '../utils/formatTranscription'
import { CheckIcon, PauseIcon, PlayIcon, SaveIcon, ZoomInIcon, ZoomOutIcon } from '../ui/icons'
import { VisualConfig, visualStyle } from '../visualConfig'
import CustomTabSheet from './CustomTabSheet'

interface TranscriptionReportProps {
  result: TranscriptionResult
  onReset: () => void
  visualConfig: VisualConfig
}

const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E']
const SCORE_STRING_Y_START = 72
const SCORE_STRING_GAP = 30
const STOP_FADE_SECONDS = 0.08
// Base spacing at 100% zoom; the timeline window (.playback-track-window)
// stays a fixed size and clips a wider/narrower absolutely-positioned track
// under it, so "zooming in" never needs a native horizontal scrollbar --
// it's the same windowed-track technique the playhead scrubbing already used.
const BASE_PIXELS_PER_SECOND = 92
const ZOOM_MIN = 0.5
const ZOOM_MAX = 4
const ZOOM_STEP = 0.25
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
type ReportView = 'sheet' | 'piano_roll' | 'guess' | 'playback' | 'outputs' | 'metrics'

const PIANO_ROLL_STRING_COLORS = ['#8e44ad', '#2a9d8f', '#ff7f50', '#4d96ff', '#e9c46a', '#e76f51']
const PIANO_ROLL_STRING_LEGEND = [
  { label: 'e', color: '#8e44ad' },
  { label: 'B', color: '#2a9d8f' },
  { label: 'G', color: '#ff7f50' },
  { label: 'D', color: '#4d96ff' },
  { label: 'A', color: '#e9c46a' },
  { label: 'E', color: '#e76f51' },
]

type ArtifactLink = {
  label: string
  href: string
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
}

export default function TranscriptionReport({ result, onReset, visualConfig }: TranscriptionReportProps) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(result.metadata.duration || 0)
  const [hasAudio, setHasAudio] = useState(false)
  const [playbackError, setPlaybackError] = useState('')
  const [savedLocally, setSavedLocally] = useState(false)
  const [isPredictionPlaying, setIsPredictionPlaying] = useState(false)
  const [predictionTime, setPredictionTime] = useState(0)
  const [reportView, setReportView] = useState<ReportView>('sheet')
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [exportError, setExportError] = useState('')
  const [isExportingPdf, setIsExportingPdf] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const synthContextRef = useRef<AudioContext | null>(null)
  const masterGainRef = useRef<GainNode | null>(null)
  const frameRef = useRef<number | null>(null)
  const predictionFrameRef = useRef<number | null>(null)
  const predictionStartedAtRef = useRef(0)
  const predictionOffsetRef = useRef(0)
  const reportRef = useRef<HTMLElement | null>(null)
  const exportRef = useRef<HTMLDivElement | null>(null)

  const activeNotesList = result.notes
  const noteStats = buildNoteStats(activeNotesList)
  const effectiveDuration = Math.max(duration, result.metadata.duration || 0, maxNoteTime(activeNotesList) + 1, 1)
  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * timelineZoom
  const totalWidth = Math.max(1100, effectiveDuration * pixelsPerSecond)
  const exportPixelsPerSecond = 58
  const exportRollViewportWidth = 1120
  const exportRollSecondsPerPage = Math.max(10, exportRollViewportWidth / exportPixelsPerSecond)
  const exportRollPageCount = Math.max(1, Math.ceil(effectiveDuration / exportRollSecondsPerPage))
  const playheadX = 56
  const adjustTimelineZoom = (delta: number) => setTimelineZoom((zoom) => clampZoom(zoom + delta))
  const artifactLinks: ArtifactLink[] = [
    { label: 'Export PDF', href: '#export-pdf', onClick: (event) => { void exportPdf(event) } },
    ...(result.artifacts?.midi_url ? [{ label: 'MIDI file', href: result.artifacts.midi_url }] : []),
    ...(result.artifacts?.npz_url ? [{ label: 'NPZ archive', href: result.artifacts.npz_url }] : []),
    ...(result.artifacts?.visualization_url ? [{ label: 'Sheet image', href: result.artifacts.visualization_url }] : []),
  ]

  const metrics = [
    { label: 'Duration', value: formatDuration(result.metadata.duration) },
    { label: 'Tempo', value: formatTempo(result.metadata.tempo) },
    { label: 'Detected notes', value: activeNotesList.length.toString() },
    { label: 'Model', value: 'Guitarica tab model' },
    { label: 'Sample rate', value: `${result.metadata.sample_rate} Hz` },
    { label: 'Feature set', value: result.metadata.feature_type.toUpperCase() },
    { label: 'Most popular string/fret', value: noteStats.mostPopularStringFret },
    { label: 'Least popular string/fret', value: noteStats.leastPopularStringFret },
    { label: 'Most popular note', value: noteStats.mostPopularNote },
  ].filter((metric): metric is { label: string; value: string } => metric !== null)

  useEffect(() => {
    let src = result.audioUrl || null
    let shouldRevoke = false

    if (!src && result.sourceFile) {
      src = URL.createObjectURL(result.sourceFile)
      shouldRevoke = true
    }

    if (!src) return undefined

    const audio = new Audio(src)
    audio.preload = 'metadata'
    audioRef.current = audio

    const handleMetadata = () => {
      setDuration(audio.duration)
      setHasAudio(true)
      setPlaybackError('')
    }
    const handleEnded = () => {
      setIsPlaying(false)
      setCurrentTime(audio.duration)
    }
    const handleError = () => {
      setHasAudio(false)
      setIsPlaying(false)
      setPlaybackError('Audio could not be loaded')
    }

    audio.addEventListener('loadedmetadata', handleMetadata)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)
    audio.load()

    return () => {
      audio.pause()
      audio.removeEventListener('loadedmetadata', handleMetadata)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
      if (shouldRevoke && src) URL.revokeObjectURL(src)
      audioRef.current = null
      setHasAudio(false)
    }
  }, [result.audioUrl, result.sourceFile])

  useEffect(() => () => stopPrediction(false), [])

  useEffect(() => {
    const update = () => {
      if (!audioRef.current || !isPlaying) return
      setCurrentTime(audioRef.current.currentTime)
      frameRef.current = requestAnimationFrame(update)
    }

    if (isPlaying) frameRef.current = requestAnimationFrame(update)
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    }
  }, [isPlaying])

  const togglePlayback = () => {
    const audio = audioRef.current
    if (!audio) return
    setPlaybackError('')

    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
      return
    }

    if (audio.currentTime >= audio.duration) {
      audio.currentTime = 0
      setCurrentTime(0)
    }

    audio.play().then(() => setIsPlaying(true)).catch(() => {
      setIsPlaying(false)
      setPlaybackError('Playback was blocked')
    })
  }

  const seek = (time: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = time
    setCurrentTime(time)
  }

  // savedLocally used to always start false on mount, so reopening a job
  // from Account history that had already been saved still offered "Save
  // audio to this device" as if it hadn't been -- it never checked whether
  // IndexedDB already had a copy for this job id. Check once per job.
  useEffect(() => {
    let cancelled = false
    if (!result.jobId) {
      setSavedLocally(false)
      return undefined
    }
    getLocalAudio(result.jobId).then((blob) => {
      if (!cancelled) setSavedLocally(Boolean(blob))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [result.jobId])

  // This audio is already available for the current session either way --
  // this button only decides whether it also survives past this session,
  // saved to this device's IndexedDB (see services/audioCache.ts). Nothing
  // here ever touches our servers.
  const canSaveLocally = Boolean(result.jobId && result.sourceFile)
  const saveAudioToDevice = async () => {
    if (!result.jobId || !result.sourceFile) return
    await saveAudioLocally(result.jobId, result.sourceFile).catch(() => undefined)
    setSavedLocally(true)
  }

  function playPrediction(startOffset = predictionTime) {
    stopPrediction(false)
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
    const audioContext = new AudioContextClass()
    synthContextRef.current = audioContext
    predictionOffsetRef.current = Math.min(Math.max(startOffset, 0), effectiveDuration)
    predictionStartedAtRef.current = audioContext.currentTime

    const masterGain = audioContext.createGain()
    masterGain.gain.setValueAtTime(0.5, audioContext.currentTime)
    masterGain.connect(audioContext.destination)
    masterGainRef.current = masterGain

    // Generating a Karplus-Strong buffer is a few thousand samples of loop
    // work; a riff with the same fret repeated dozens of times (extremely
    // common) would otherwise redo that work identically every time. Round
    // to a coarse grid so near-identical notes share a buffer -- a <=25ms
    // difference in ring-out length is inaudible on a decay tail.
    const pluckBufferCache = new Map<string, AudioBuffer>()
    const getPluckBuffer = (frequency: number, ringSeconds: number) => {
      const key = `${Math.round(frequency)}_${(Math.round(ringSeconds * 20) / 20).toFixed(2)}`
      let buffer = pluckBufferCache.get(key)
      if (!buffer) {
        buffer = createPluckBuffer(audioContext, frequency, ringSeconds)
        pluckBufferCache.set(key, buffer)
      }
      return buffer
    }

    activeNotesList.forEach((note) => {
      const midi = note.midi
      if (!midi || !Number.isFinite(midi)) return
      if (note.time + Math.max(note.duration || 0.18, 0.08) < predictionOffsetRef.current) return

      const start = audioContext.currentTime + Math.max(note.time - predictionOffsetRef.current, 0)
      // A real pluck rings well past the note's nominal duration (that's
      // what the sustain/decay tail sounds like on an actual guitar) --
      // give the buffer room for that instead of cutting it off exactly at
      // note.duration, which is what made the old oscillator version sound
      // clipped rather than plucked.
      const noteSeconds = Math.max(note.duration || 0.18, 0.08)
      const ringSeconds = Math.min(noteSeconds + 1.1, 2.6)
      const frequency = midiToFrequency(midi)
      const buffer = getPluckBuffer(frequency, ringSeconds)
      playPluckedNote(audioContext, masterGain, buffer, frequency, start, ringSeconds)
    })

    setIsPredictionPlaying(true)
    setPredictionTime(predictionOffsetRef.current)
    predictionFrameRef.current = requestAnimationFrame(updatePredictionClock)
  }

  // Fades the master bus out instead of hard-closing the AudioContext --
  // closing mid-note (hitting Stop, seeking, or reaching the end) used to
  // cut every still-ringing string off instantly, which is exactly the
  // "sudden stop" that sounded wrong. The close() is deferred until after
  // the fade finishes so nothing pops.
  function stopPrediction(resetToStart = false) {
    const audioContext = synthContextRef.current
    const masterGain = masterGainRef.current
    if (audioContext && masterGain) {
      const now = audioContext.currentTime
      masterGain.gain.cancelScheduledValues(now)
      masterGain.gain.setValueAtTime(masterGain.gain.value, now)
      masterGain.gain.linearRampToValueAtTime(0.0001, now + STOP_FADE_SECONDS)
      window.setTimeout(() => { audioContext.close().catch(() => undefined) }, STOP_FADE_SECONDS * 1000 + 30)
    } else {
      audioContext?.close().catch(() => undefined)
    }
    synthContextRef.current = null
    masterGainRef.current = null
    if (predictionFrameRef.current) cancelAnimationFrame(predictionFrameRef.current)
    predictionFrameRef.current = null
    setIsPredictionPlaying(false)
    if (resetToStart) setPredictionTime(0)
  }

  function updatePredictionClock() {
    const audioContext = synthContextRef.current
    if (!audioContext) return

    const elapsed = audioContext.currentTime - predictionStartedAtRef.current
    const nextTime = Math.min(effectiveDuration, predictionOffsetRef.current + elapsed)
    setPredictionTime(nextTime)

    if (nextTime >= effectiveDuration) {
      stopPrediction(false)
      return
    }

    predictionFrameRef.current = requestAnimationFrame(updatePredictionClock)
  }

  function seekPrediction(time: number) {
    const nextTime = Math.min(Math.max(time, 0), effectiveDuration)
    setPredictionTime(nextTime)
    if (isPredictionPlaying) playPrediction(nextTime)
  }

  const activeNotes = activeNotesList.filter((note) => Math.abs(note.time - currentTime) < 0.14)
  const activePredictionNotes = activeNotesList.filter((note) => Math.abs(note.time - predictionTime) < 0.14)

  async function exportPdf(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    setExportError('')
    setIsExportingPdf(true)

    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      if (!exportRef.current) throw new Error('Export view did not mount.')

      const html2pdf = (await import('html2pdf.js')).default
      await html2pdf()
        .set({
          filename: `${safeFileName(result.source.name)}-guitarica.pdf`,
          margin: 0.35,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, backgroundColor: '#f8f7f3', useCORS: true },
          jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape' },
        })
        .from(exportRef.current)
        .save()
    } catch {
      setExportError('PDF export failed. Please try again.')
    } finally {
      setIsExportingPdf(false)
    }
  }

  return (
    <section className="report" ref={reportRef} aria-labelledby="report-title">
      <header className="report-header" style={visualStyle(visualConfig.reportHeader)}>
        <div className="report-identity">
          <p>Analysis report</p>
          <h1 id="report-title">{result.source.name}</h1>
          <span>
            {result.source.kind === 'youtube' ? 'YouTube' : 'Audio file'}
            {' / '}
            {formatBytes(result.source.size_bytes)}
          </span>
        </div>
        <button type="button" className="report-new" onClick={onReset}>New analysis</button>
      </header>

      <div className="report-body">
        <aside
          className="report-summary"
          style={visualStyle(visualConfig.reportSummary)}
          aria-label="Analysis summary"
        >
          <nav className="report-view-nav" aria-label="Report sections">
            {[
              { id: 'sheet', label: 'Sheet' },
              { id: 'piano_roll', label: 'Piano roll' },
              { id: 'guess', label: 'Guess' },
              { id: 'playback', label: 'Playback' },
              { id: 'outputs', label: 'Outputs' },
              { id: 'metrics', label: 'Metrics' },
            ].map((view) => (
              <button
                key={view.id}
                type="button"
                className={reportView === view.id ? 'report-view-active' : undefined}
                onClick={() => setReportView(view.id as ReportView)}
              >
                {view.label}
              </button>
            ))}
          </nav>

          <dl className="report-metrics report-metrics-compact">
            {metrics.slice(0, 4).map((metric) => (
              <Metric key={metric.label} label={metric.label} value={metric.value} />
            ))}
          </dl>
        </aside>

        <section
          className="report-stage"
          style={visualStyle(visualConfig.reportScore)}
          aria-label="Analysis output"
        >
          {reportView === 'sheet' && (
            <div className="report-view">
              <header className="score-header">
                <span>Guitarica sheet</span>
                <span>{activeNotesList.length} notes</span>
              </header>

              <CustomTabSheet
                notes={activeNotesList}
                tempo={result.metadata.tempo}
                duration={effectiveDuration}
              />
            </div>
          )}

          {reportView === 'guess' && (
            <div className="report-view">
              <header className="score-header">
                <span>Predicted audio playback</span>
                <span>{formatDuration(predictionTime)}</span>
              </header>

              <div className="playback-controls report-playback-controls">
                <div className="playback-controls-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => isPredictionPlaying ? stopPrediction(false) : playPrediction()}
                    disabled={activeNotesList.length === 0}
                    aria-label={isPredictionPlaying ? 'Stop guess' : 'Play guess'}
                    title={isPredictionPlaying ? 'Stop guess' : 'Play guess'}
                  >
                    {isPredictionPlaying ? <PauseIcon /> : <PlayIcon />}
                  </button>
                </div>
                <div className="playback-time">
                  <span>{formatDuration(predictionTime)}</span>
                  <span>{formatDuration(effectiveDuration)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max={Math.max(effectiveDuration, 0.01)}
                  step="0.01"
                  value={Math.min(predictionTime, effectiveDuration)}
                  onChange={(event) => seekPrediction(Number(event.target.value))}
                  disabled={activeNotesList.length === 0}
                  aria-label="Predicted playback position"
                />
              </div>

              <ScoreTimeline
                notes={activeNotesList}
                activeNotes={activePredictionNotes}
                totalWidth={totalWidth}
                effectiveDuration={effectiveDuration}
                pixelsPerSecond={pixelsPerSecond}
                playheadX={playheadX}
                currentTime={predictionTime}
                zoom={timelineZoom}
                onZoomChange={setTimelineZoom}
                onZoomStep={adjustTimelineZoom}
              />
            </div>
          )}

          {reportView === 'piano_roll' && (
            <div className="report-view">
              <header className="score-header">
                <span>Piano roll playback</span>
                <span>{formatDuration(currentTime)}</span>
              </header>

              <div className="playback-controls report-playback-controls">
                <div className="playback-controls-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={togglePlayback}
                    disabled={!hasAudio}
                    aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
                    title={isPlaying ? 'Pause audio' : 'Play audio'}
                  >
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  {canSaveLocally && (
                    <button
                      type="button"
                      className={savedLocally ? 'icon-btn icon-btn-saved' : 'icon-btn'}
                      onClick={saveAudioToDevice}
                      disabled={savedLocally}
                      aria-label={savedLocally ? 'Saved to this device' : 'Save audio to this device'}
                      title={savedLocally ? 'Saved to this device' : 'Save audio to this device'}
                    >
                      {savedLocally ? <CheckIcon /> : <SaveIcon />}
                    </button>
                  )}
                </div>
                <div className="playback-time">
                  <span>{formatDuration(currentTime)}</span>
                  <span>{formatDuration(duration || result.metadata.duration)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max={Math.max(duration || result.metadata.duration, 0.01)}
                  step="0.01"
                  value={Math.min(currentTime, duration || result.metadata.duration)}
                  onChange={(event) => seek(Number(event.target.value))}
                  disabled={!hasAudio}
                  aria-label="Playback position"
                />
                {playbackError && <p className="form-error">{playbackError}</p>}
              </div>

              <PianoRollLegend />

              <PianoRollTimeline
                notes={activeNotesList}
                totalWidth={totalWidth}
                effectiveDuration={effectiveDuration}
                pixelsPerSecond={pixelsPerSecond}
                playheadX={playheadX}
                currentTime={currentTime}
                zoom={timelineZoom}
                onZoomChange={setTimelineZoom}
                onZoomStep={adjustTimelineZoom}
              />
            </div>
          )}

          {reportView === 'playback' && (
            <div className="report-view">
              <header className="score-header">
                <span>Original audio playback</span>
                <span>{formatDuration(currentTime)}</span>
              </header>

              <div className="playback-controls report-playback-controls">
                <div className="playback-controls-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={togglePlayback}
                    disabled={!hasAudio}
                    aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
                    title={isPlaying ? 'Pause audio' : 'Play audio'}
                  >
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  {canSaveLocally && (
                    <button
                      type="button"
                      className={savedLocally ? 'icon-btn icon-btn-saved' : 'icon-btn'}
                      onClick={saveAudioToDevice}
                      disabled={savedLocally}
                      aria-label={savedLocally ? 'Saved to this device' : 'Save audio to this device'}
                      title={savedLocally ? 'Saved to this device' : 'Save audio to this device'}
                    >
                      {savedLocally ? <CheckIcon /> : <SaveIcon />}
                    </button>
                  )}
                </div>
                <div className="playback-time">
                  <span>{formatDuration(currentTime)}</span>
                  <span>{formatDuration(duration || result.metadata.duration)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max={Math.max(duration || result.metadata.duration, 0.01)}
                  step="0.01"
                  value={Math.min(currentTime, duration || result.metadata.duration)}
                  onChange={(event) => seek(Number(event.target.value))}
                  disabled={!hasAudio}
                  aria-label="Playback position"
                />
                {playbackError && <p className="form-error">{playbackError}</p>}
              </div>

              <ScoreTimeline
                notes={activeNotesList}
                activeNotes={activeNotes}
                totalWidth={totalWidth}
                effectiveDuration={effectiveDuration}
                pixelsPerSecond={pixelsPerSecond}
                playheadX={playheadX}
                currentTime={currentTime}
                zoom={timelineZoom}
                onZoomChange={setTimelineZoom}
                onZoomStep={adjustTimelineZoom}
              />
            </div>
          )}

          {reportView === 'outputs' && (
            <div className="report-view output-view">
              <header className="score-header">
                <span>Generated files</span>
                <span>{artifactLinks.length} items</span>
              </header>

              <nav className="artifact-links" aria-label="Generated outputs">
                {artifactLinks.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    target={link.onClick ? undefined : '_blank'}
                    rel={link.onClick ? undefined : 'noreferrer'}
                    onClick={link.onClick}
                  >
                    <span>{link.label}</span>
                    <small>{describeArtifact(link.label)}</small>
                  </a>
                ))}
              </nav>
              {exportError && <p className="form-error">{exportError}</p>}
            </div>
          )}

          {reportView === 'metrics' && (
            <div className="report-view metrics-view">
              <header className="score-header">
                <span>Output metrics</span>
                <span>{result.metadata.model || 'Model'}</span>
              </header>

              <dl className="report-metrics report-metrics-full">
                {metrics.map((metric) => (
                  <Metric key={metric.label} label={metric.label} value={metric.value} />
                ))}
              </dl>
            </div>
          )}
        </section>
      </div>

      {isExportingPdf && (
        <div className="report-export-staging" aria-hidden="true">
          <article className="report-export" ref={exportRef}>
            <header className="report-export-header">
              <p>Guitarica analysis report</p>
              <h2>{result.source.name}</h2>
              <span>
                {result.source.kind === 'youtube' ? 'YouTube' : 'Audio file'}
                {' / '}
                {formatBytes(result.source.size_bytes)}
              </span>
            </header>

            <section className="report-export-section report-export-metrics">
              <h3>Metrics</h3>
              <dl className="report-metrics report-metrics-full">
                {metrics.map((metric) => (
                  <Metric key={`export-${metric.label}`} label={metric.label} value={metric.value} />
                ))}
              </dl>
            </section>

            <section className="report-export-section report-export-break report-export-page-start">
              <h3>Sheet music</h3>
              <CustomTabSheet
                notes={activeNotesList}
                tempo={result.metadata.tempo}
                duration={effectiveDuration}
              />
            </section>

            <section className="report-export-section report-export-page-start">
              <h3>Piano roll</h3>
              <PianoRollLegend />
              <div className="report-export-roll-pages">
                {Array.from({ length: exportRollPageCount }).map((_, index) => {
                  const windowStart = index * exportRollSecondsPerPage
                  const windowEnd = Math.min(effectiveDuration, windowStart + exportRollSecondsPerPage)
                  return (
                    <div
                      className={index === 0 ? 'report-export-roll-page' : 'report-export-roll-page report-export-page-start'}
                      key={`roll-page-${index}`}
                    >
                      <p className="report-export-roll-window">
                        {`Segment ${index + 1} of ${exportRollPageCount}: ${formatTimelineStamp(windowStart)} - ${formatTimelineStamp(windowEnd)}`}
                      </p>
                      <PianoRollStatic
                        notes={activeNotesList}
                        viewportWidth={exportRollViewportWidth}
                        effectiveDuration={effectiveDuration}
                        pixelsPerSecond={exportPixelsPerSecond}
                        windowStart={windowStart}
                        windowEnd={windowEnd}
                      />
                    </div>
                  )
                })}
              </div>
            </section>
          </article>
        </div>
      )}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function ScoreTimeline({
  notes,
  activeNotes,
  totalWidth,
  effectiveDuration,
  pixelsPerSecond,
  playheadX,
  currentTime,
  zoom,
  onZoomChange,
  onZoomStep,
}: {
  notes: TranscribedNote[]
  activeNotes: TranscribedNote[]
  totalWidth: number
  effectiveDuration: number
  pixelsPerSecond: number
  playheadX: number
  currentTime: number
  zoom: number
  onZoomChange: (zoom: number) => void
  onZoomStep: (delta: number) => void
}) {
  const trackWindowRef = useRef<HTMLDivElement | null>(null)

  // Ctrl/Cmd + scroll-wheel zoom, CapCut-style. This has to be a native,
  // non-passive listener -- React's onWheel is registered passive by
  // default, so calling preventDefault() there would only warn in the
  // console and still let the browser's own page-zoom gesture fire.
  useEffect(() => {
    const node = trackWindowRef.current
    if (!node) return undefined

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      onZoomStep(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
    }

    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [onZoomStep])

  return (
    <div className="score-viewport-wrap">
      <div className="score-viewport">
        <div className="playback-string-labels" aria-hidden="true">
          {STRING_LABELS.map((label, index) => (
            <span key={`${label}-${index}`} style={{ top: SCORE_STRING_Y_START - 9 + index * SCORE_STRING_GAP }}>
              {label}
            </span>
          ))}
        </div>
        <div className="playback-track-window" ref={trackWindowRef} title="Ctrl/Cmd + scroll to zoom">
          <div className="playhead" style={{ left: playheadX }} />
          <div
            className="score-track"
            style={{
              width: totalWidth,
              transform: `translateX(${playheadX - currentTime * pixelsPerSecond}px)`,
            }}
          >
            <ScoreSvg
              notes={notes}
              activeNotes={activeNotes}
              totalWidth={totalWidth}
              effectiveDuration={effectiveDuration}
              pixelsPerSecond={pixelsPerSecond}
            />
          </div>
        </div>
      </div>
      <ZoomControl zoom={zoom} onChange={onZoomChange} onStep={onZoomStep} />
    </div>
  )
}

function PianoRollTimeline({
  notes,
  totalWidth,
  effectiveDuration,
  pixelsPerSecond,
  playheadX,
  currentTime,
  zoom,
  onZoomChange,
  onZoomStep,
}: {
  notes: TranscribedNote[]
  totalWidth: number
  effectiveDuration: number
  pixelsPerSecond: number
  playheadX: number
  currentTime: number
  zoom: number
  onZoomChange: (zoom: number) => void
  onZoomStep: (delta: number) => void
}) {
  const trackWindowRef = useRef<HTMLDivElement | null>(null)
  const pitchRows = buildPitchRows(notes)

  useEffect(() => {
    const node = trackWindowRef.current
    if (!node) return undefined

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      onZoomStep(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
    }

    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [onZoomStep])

  return (
    <div className="score-viewport-wrap">
      <div className="score-viewport piano-roll-viewport">
        <div className="playback-string-labels piano-roll-pitch-labels" aria-hidden="true">
          {pitchRows.map((midi) => (
            <span key={midi} style={{ top: midiToPianoY(midi, pitchRows) - 8 }}>
              {midiToPitchLabel(midi)}
            </span>
          ))}
        </div>
        <div className="playback-track-window" ref={trackWindowRef} title="Ctrl/Cmd + scroll to zoom">
          <div className="playhead" style={{ left: playheadX }} />
          <div
            className="score-track"
            style={{
              width: totalWidth,
              transform: `translateX(${playheadX - currentTime * pixelsPerSecond}px)`,
            }}
          >
            <PianoRollSvg
              notes={notes}
              pitchRows={pitchRows}
              totalWidth={totalWidth}
              effectiveDuration={effectiveDuration}
              pixelsPerSecond={pixelsPerSecond}
              currentTime={currentTime}
            />
          </div>
        </div>
      </div>
      <ZoomControl zoom={zoom} onChange={onZoomChange} onStep={onZoomStep} />
    </div>
  )
}

function ZoomControl({
  zoom,
  onChange,
  onStep,
}: {
  zoom: number
  onChange: (zoom: number) => void
  onStep: (delta: number) => void
}) {
  return (
    <div className="score-zoom-control" aria-label="Timeline zoom">
      <button
        type="button"
        className="icon-btn"
        onClick={() => onStep(-ZOOM_STEP)}
        disabled={zoom <= ZOOM_MIN}
        aria-label="Zoom out"
        title="Zoom out"
      >
        <ZoomOutIcon />
      </button>
      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={zoom}
        onChange={(event) => onChange(clampZoom(Number(event.target.value)))}
        aria-label="Timeline zoom level"
        className="zoom-slider"
      />
      <button
        type="button"
        className="icon-btn"
        onClick={() => onStep(ZOOM_STEP)}
        disabled={zoom >= ZOOM_MAX}
        aria-label="Zoom in"
        title="Zoom in"
      >
        <ZoomInIcon />
      </button>
      <span className="zoom-level-label">{Math.round(zoom * 100)}%</span>
    </div>
  )
}

function ScoreSvg({
  notes,
  activeNotes,
  totalWidth,
  effectiveDuration,
  pixelsPerSecond,
}: {
  notes: TranscribedNote[]
  activeNotes: TranscribedNote[]
  totalWidth: number
  effectiveDuration: number
  pixelsPerSecond: number
}) {
  return (
    <svg viewBox={`0 0 ${totalWidth} 260`} className="score-svg" role="img">
      {Array.from({ length: Math.ceil(effectiveDuration / 2) + 1 }).map((_, index) => {
        const x = index * 2 * pixelsPerSecond
        return (
          <g key={`measure-${index}`}>
            <line x1={x} y1="48" x2={x} y2="228" className="measure-line" />
            <text x={x + 8} y="26" className="measure-label">{index * 2}s</text>
          </g>
        )
      })}

      {STRING_LABELS.map((_, index) => {
        const y = SCORE_STRING_Y_START + index * SCORE_STRING_GAP
        return (
          <line key={index} x1="0" y1={y} x2={totalWidth} y2={y} className="string-line" />
        )
      })}

      {notes.map((note, index) => {
        const x = note.time * pixelsPerSecond
        const y = SCORE_STRING_Y_START + note.stringIdx * SCORE_STRING_GAP
        const isActive = activeNotes.some((active) => (
          active.time === note.time &&
          active.stringIdx === note.stringIdx &&
          active.fret === note.fret
        ))

        return (
          <g key={`${note.time}-${note.stringIdx}-${index}`}>
            <rect x={x - 10} y={y - 10} width="20" height="20" className="note-mask" />
            {isActive && <rect x={x - 11} y={y - 11} width="22" height="22" className="active-note-box" />}
            <text x={x} y={y + 4} className={isActive ? 'note-text active-note-text' : 'note-text'}>
              {note.fret}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function PianoRollSvg({
  notes,
  pitchRows,
  totalWidth,
  effectiveDuration,
  pixelsPerSecond,
  currentTime,
  windowStart = 0,
  windowEnd = effectiveDuration,
}: {
  notes: TranscribedNote[]
  pitchRows: number[]
  totalWidth: number
  effectiveDuration: number
  pixelsPerSecond: number
  currentTime: number
  windowStart?: number
  windowEnd?: number
}) {
  const clampedWindowStart = Math.min(Math.max(windowStart, 0), effectiveDuration)
  const clampedWindowEnd = Math.min(Math.max(windowEnd, clampedWindowStart), effectiveDuration)

  if (!pitchRows.length) {
    return (
      <svg viewBox={`0 0 ${totalWidth} 260`} className="score-svg piano-roll-svg" role="img">
        <text x="14" y="130" className="measure-label">No notes to render.</text>
      </svg>
    )
  }

  return (
    <svg viewBox={`0 0 ${totalWidth} 260`} className="score-svg piano-roll-svg" role="img">
      {buildMeasureTicks(clampedWindowStart, clampedWindowEnd).map((time) => {
        const x = (time - clampedWindowStart) * pixelsPerSecond
        return (
          <g key={`roll-measure-${time}`}>
            <line x1={x} y1="38" x2={x} y2="236" className="measure-line" />
            <text x={x + 8} y="24" className="measure-label">{formatTimelineStamp(time)}</text>
          </g>
        )
      })}

      {pitchRows.map((midi) => {
        const y = midiToPianoY(midi, pitchRows)
        const isPitchLabel = midi % 12 === 0
        return (
          <g key={`pitch-${midi}`}>
            <line
              x1="0"
              y1={y}
              x2={totalWidth}
              y2={y}
              className={isPitchLabel ? 'piano-roll-grid-strong' : 'piano-roll-grid-line'}
            />
          </g>
        )
      })}

      {notes.map((note, index) => {
        const midi = resolveNoteMidi(note)
        const noteDuration = Math.max(note.duration || 0.12, 0.08)
        const noteStart = note.time
        const noteEnd = note.time + noteDuration
        if (noteEnd <= clampedWindowStart || noteStart >= clampedWindowEnd) return null

        const visibleStart = Math.max(noteStart, clampedWindowStart)
        const visibleEnd = Math.min(noteEnd, clampedWindowEnd)
        const x = (visibleStart - clampedWindowStart) * pixelsPerSecond
        const width = Math.max(4, (visibleEnd - visibleStart) * pixelsPerSecond)
        const y = midiToPianoY(midi, pitchRows)
        const isActive = currentTime >= noteStart && currentTime <= noteEnd
        const stringColor = pianoRollStringColor(note.stringIdx)

        return (
          <g key={`roll-note-${note.time}-${note.stringIdx}-${index}`}>
            <rect
              x={x}
              y={y - 6}
              width={width}
              height="12"
              rx="2"
              style={{ fill: stringColor }}
              className={isActive ? 'piano-roll-note piano-roll-note-active' : 'piano-roll-note'}
            />
          </g>
        )
      })}
    </svg>
  )
}

function PianoRollLegend() {
  return (
    <div className="piano-roll-legend" aria-label="Piano roll legend">
      <span className="piano-roll-legend-title">Legend</span>
      <span className="piano-roll-legend-item">
        <i className="piano-roll-legend-note" aria-hidden="true" />
        Active note follows playback
      </span>
      {PIANO_ROLL_STRING_LEGEND.map((entry) => (
        <span className="piano-roll-legend-item" key={entry.label}>
          <i style={{ background: entry.color }} aria-hidden="true" />
          {entry.label} string
        </span>
      ))}
    </div>
  )
}

function PianoRollStatic({
  notes,
  viewportWidth,
  effectiveDuration,
  pixelsPerSecond,
  windowStart,
  windowEnd,
}: {
  notes: TranscribedNote[]
  viewportWidth: number
  effectiveDuration: number
  pixelsPerSecond: number
  windowStart: number
  windowEnd: number
}) {
  const pitchRows = buildPitchRows(notes)
  const windowWidth = Math.max(1, (windowEnd - windowStart) * pixelsPerSecond)

  return (
    <div className="score-viewport piano-roll-viewport report-export-roll-canvas">
      <div className="playback-string-labels piano-roll-pitch-labels" aria-hidden="true">
        {pitchRows.map((midi) => (
          <span key={midi} style={{ top: midiToPianoY(midi, pitchRows) - 8 }}>
            {midiToPitchLabel(midi)}
          </span>
        ))}
      </div>
      <div className="playback-track-window" style={{ width: viewportWidth }}>
        <div
          className="score-track"
          style={{
            width: windowWidth,
            transform: 'translateX(0px)',
          }}
        >
          <PianoRollSvg
            notes={notes}
            pitchRows={pitchRows}
            totalWidth={windowWidth}
            effectiveDuration={effectiveDuration}
            pixelsPerSecond={pixelsPerSecond}
            currentTime={-1}
            windowStart={windowStart}
            windowEnd={windowEnd}
          />
        </div>
      </div>
    </div>
  )
}

function maxNoteTime(notes: TranscribedNote[]): number {
  return notes.length ? Math.max(...notes.map((note) => note.time)) : 0
}

function midiToFrequency(midi: number): number {
  return 440 * (2 ** ((midi - 69) / 12))
}

function buildPitchRows(notes: TranscribedNote[]): number[] {
  const uniquePitches = Array.from(new Set(notes.map((note) => resolveNoteMidi(note))))
  return uniquePitches.sort((a, b) => a - b)
}

function midiToPianoY(midi: number, pitchRows: number[]): number {
  const drawableTop = 44
  const drawableHeight = 184
  if (!pitchRows.length) return drawableTop + drawableHeight / 2
  if (pitchRows.length === 1) return drawableTop + drawableHeight / 2
  const rowIndex = pitchRows.indexOf(midi)
  const safeIndex = rowIndex === -1 ? pitchRows.length - 1 : rowIndex
  const fromTop = pitchRows.length - 1 - safeIndex
  const ratio = fromTop / (pitchRows.length - 1)
  return drawableTop + ratio * drawableHeight
}

function stringToFallbackMidi(stringIdx: number, fret: number): number {
  const openStringMidi = [64, 59, 55, 50, 45, 40]
  const base = openStringMidi[Math.min(Math.max(stringIdx, 0), openStringMidi.length - 1)] || 40
  return base + Math.max(fret, 0)
}

function resolveNoteMidi(note: TranscribedNote): number {
  return typeof note.midi === 'number' && Number.isFinite(note.midi)
    ? note.midi
    : stringToFallbackMidi(note.stringIdx, note.fret)
}

function pianoRollStringColor(stringIdx: number): string {
  return PIANO_ROLL_STRING_COLORS[Math.min(Math.max(stringIdx, 0), PIANO_ROLL_STRING_COLORS.length - 1)] || '#6c6456'
}

function buildNoteStats(notes: TranscribedNote[]): {
  mostPopularStringFret: string
  leastPopularStringFret: string
  mostPopularNote: string
} {
  if (!notes.length) {
    return {
      mostPopularStringFret: 'N/A',
      leastPopularStringFret: 'N/A',
      mostPopularNote: 'N/A',
    }
  }

  const stringFretCounts = new Map<string, number>()
  const midiCounts = new Map<number, number>()

  notes.forEach((note) => {
    const comboKey = `${stringLabelFromIdx(note.stringIdx)}${note.fret}`
    stringFretCounts.set(comboKey, (stringFretCounts.get(comboKey) || 0) + 1)

    const midi = resolveNoteMidi(note)
    midiCounts.set(midi, (midiCounts.get(midi) || 0) + 1)
  })

  const sortedCombos = Array.from(stringFretCounts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })

  const sortedNotes = Array.from(midiCounts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0] - b[0]
  })

  const topCombo = sortedCombos[0]
  const leastCombo = sortedCombos[sortedCombos.length - 1]
  const topNote = sortedNotes[0]

  return {
    mostPopularStringFret: topCombo ? `${formatStringFretLabel(topCombo[0])} (${topCombo[1]}x)` : 'N/A',
    leastPopularStringFret: leastCombo ? `${formatStringFretLabel(leastCombo[0])} (${leastCombo[1]}x)` : 'N/A',
    mostPopularNote: topNote ? `${midiToPitchLabel(topNote[0])} (${topNote[1]}x)` : 'N/A',
  }
}

function stringLabelFromIdx(stringIdx: number): string {
  return STRING_LABELS[Math.min(Math.max(stringIdx, 0), STRING_LABELS.length - 1)] || 'E'
}

function formatStringFretLabel(raw: string): string {
  const stringLabel = raw.slice(0, 1)
  const fret = raw.slice(1)
  return `String ${stringLabel} / fret ${fret}`
}

function midiToPitchLabel(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const note = names[((midi % 12) + 12) % 12] || 'C'
  const octave = Math.floor(midi / 12) - 1
  return `${note}${octave}`
}

function formatTimelineStamp(seconds: number): string {
  const safeSeconds = Math.max(0, seconds)
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = Math.floor(safeSeconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainder}`
}

function buildMeasureTicks(windowStart: number, windowEnd: number): number[] {
  const tickStep = 2
  const ticks: number[] = []
  const first = Math.floor(windowStart / tickStep) * tickStep
  for (let time = first; time <= windowEnd + 0.0001; time += tickStep) {
    if (time < windowStart - 0.0001) continue
    ticks.push(time)
  }
  if (!ticks.length) ticks.push(windowStart)
  return ticks
}

// Karplus-Strong plucked-string synthesis: fill one period with noise (the
// "pluck"), then repeatedly average each sample with its neighbor and decay
// it slightly -- the feedback loop is what makes it ring and decay like an
// actual plucked string instead of a flat oscillator tone. No audio
// samples/assets needed, runs entirely client-side.
function createPluckBuffer(audioContext: AudioContext | OfflineAudioContext, frequency: number, durationSeconds: number): AudioBuffer {
  const sampleRate = audioContext.sampleRate
  const bufferLength = Math.max(1, Math.round(sampleRate * durationSeconds))
  const buffer = audioContext.createBuffer(1, bufferLength, sampleRate)
  const data = buffer.getChannelData(0)

  const period = Math.max(2, Math.round(sampleRate / frequency))
  const ring = new Float32Array(period)
  for (let i = 0; i < period; i += 1) ring[i] = Math.random() * 2 - 1

  const decay = 0.994
  let index = 0
  for (let i = 0; i < bufferLength; i += 1) {
    const current = ring[index]
    const next = ring[(index + 1) % period]
    data[i] = current
    ring[index] = decay * 0.5 * (current + next)
    index = (index + 1) % period
  }

  // Belt-and-suspenders fade over the last ~25ms regardless of how much
  // amplitude the decay loop above left at the tail -- guarantees no click
  // at the buffer's natural end, on top of the per-note release envelope
  // applied separately in playPluckedNote.
  const tailSamples = Math.min(bufferLength, Math.round(sampleRate * 0.025))
  for (let i = 0; i < tailSamples; i += 1) {
    const fade = i / tailSamples
    data[bufferLength - tailSamples + i] *= fade
  }

  return buffer
}

// Schedules one plucked note: the raw Karplus-Strong buffer through a
// gentle low-pass (rounds off the noise burst's harshness into something
// closer to a string/body tone) and a release envelope (smooth exponential
// decay, not a hard stop) into the shared master bus.
function playPluckedNote(
  audioContext: AudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  frequency: number,
  startTime: number,
  ringSeconds: number,
): void {
  const source = audioContext.createBufferSource()
  source.buffer = buffer

  const tone = audioContext.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.setValueAtTime(Math.min(5200, frequency * 5 + 800), startTime)
  tone.Q.setValueAtTime(0.7, startTime)

  const body = audioContext.createBiquadFilter()
  body.type = 'highpass'
  body.frequency.setValueAtTime(70, startTime)

  const envelope = audioContext.createGain()
  envelope.gain.setValueAtTime(0.0001, startTime)
  envelope.gain.exponentialRampToValueAtTime(1, startTime + 0.006)
  envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + ringSeconds)

  source.connect(tone)
  tone.connect(body)
  body.connect(envelope)
  envelope.connect(destination)
  source.start(startTime)
}

function safeFileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'guitarica-transcription'
}

function describeArtifact(label: string): string {
  if (label === 'Export PDF') return 'Clean report sheet for submission or sharing.'
  if (label === 'MIDI file') return 'Playable model output for DAWs and synth tools.'
  if (label === 'NPZ archive') return 'Raw prediction tensors and onset metrics.'
  return 'Rendered tablature and piano-roll image.'
}
