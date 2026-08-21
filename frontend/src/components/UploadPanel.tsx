import { useEffect, useRef, useState } from 'react'
import { Session } from '@supabase/supabase-js'
import useQueuedJob from '../hooks/useQueuedJob'
import { saveAudioLocally } from '../services/audioCache'
import { cancelJob, expireMyJobNow, getPlatformSettings, queueUpload, restoreJob } from '../services/jobStore'
import { saveLocalHistory } from '../services/localHistoryCache'
import { transcribeUpload } from '../services/transcriptionApi'
import { TranscriptionResult } from '../types/transcription'
import { errorMessage, formatBytes, formatDuration, mapBackendNotes } from '../utils/formatTranscription'
import { estimateProcessingSeconds } from '../utils/processingEstimate'
import InlinePlayback from './InlinePlayback'
import MarqueeTitle from './MarqueeTitle'
import { ProcessingMode } from './ProcessingModeSelect'
import ProcessingOptions from './ProcessingOptions'
import ProgressMeter from './ProgressMeter'
import { SessionStorageMode } from './SessionStoragePreference'

interface UploadPanelProps {
  onComplete: (result: TranscriptionResult) => void
  session: Session | null
}

export default function UploadPanel({ onComplete, session }: UploadPanelProps) {
  const [file, setFile] = useState<File | null>(null)
  const [audioDuration, setAudioDuration] = useState<number | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState('')
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('guitarica')
  const [sessionStorageMode, setSessionStorageMode] = useState<SessionStorageMode>('cloud')
  const [keepAudioLocally, setKeepAudioLocally] = useState(false)
  const [keepDataLocally, setKeepDataLocally] = useState(false)
  const [communityAvailable, setCommunityAvailable] = useState(false)
  const [queuedJobId, setQueuedJobId] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const asyncJobsEnabled = import.meta.env.VITE_ASYNC_JOBS_ENABLED === 'true'
  const { job, queueStatus } = useQueuedJob(queuedJobId)

  useEffect(() => {
    getPlatformSettings().then((settings) => setCommunityAvailable(settings.communityProcessingEnabled)).catch(() => undefined)
  }, [])

  useEffect(() => {
    setAudioDuration(null)
    if (!file) return undefined

    const url = URL.createObjectURL(file)
    const audio = new Audio(url)
    audio.addEventListener('loadedmetadata', () => {
      setAudioDuration(Number.isFinite(audio.duration) ? audio.duration : null)
    })

    return () => {
      audio.pause()
      URL.revokeObjectURL(url)
    }
  }, [file])

  // Stay on this screen while a queued job runs -- the user keeps the local
  // audio to listen to, and the report opens here the moment it's ready,
  // instead of being bounced to Account with no way to hear their upload.
  useEffect(() => {
    if (!job) return
    if (job.status === 'completed') {
      restoreJob(job).then(async (result) => {
        // This browser still has the file it just uploaded in memory for
        // this session, regardless of whether "keep local copy" was
        // checked -- that opt-in only decides whether it also survives
        // past this session (IndexedDB), never whether playback works now.
        if (result) onComplete({ ...result, sourceFile: result.sourceFile || file })
        if (result && (sessionStorageMode === 'ephemeral' || keepDataLocally)) {
          const { audioUrl: _audioUrl, sourceFile: _sourceFile, ...rest } = result
          await saveLocalHistory({
            jobId: job.id,
            sourceKind: 'upload',
            sourceName: job.source_name,
            createdAt: job.created_at,
            hasLocalAudio: sessionStorageMode === 'ephemeral' || keepAudioLocally,
            result: rest,
          }).catch(() => undefined)
        }
        if (sessionStorageMode === 'ephemeral') await expireMyJobNow(job.id).catch(() => undefined)
        setQueuedJobId(null)
      })
    } else if (job.status === 'failed') {
      setError(job.error_message || 'This transcription could not be completed.')
      setQueuedJobId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status])

  const handleSubmit = async () => {
    if (!file) return
    setIsProcessing(true)
    setError('')

    try {
      if (asyncJobsEnabled) {
        if (!session) throw new Error('Sign in before adding work to the queue.')
        const shouldKeepLocalCopy = sessionStorageMode === 'ephemeral' || keepAudioLocally
        const queued = await queueUpload(file, audioDuration, session, processingMode === 'community')
        if (shouldKeepLocalCopy) await saveAudioLocally(queued.id, file).catch(() => undefined)
        setAudioUrl(URL.createObjectURL(file))
        setQueuedJobId(queued.id)
        return
      }
      const payload = await transcribeUpload(file)
      onComplete({
        notes: mapBackendNotes(payload),
        metadata: payload.metadata,
        source: payload.source,
        audioUrl: null,
        sourceFile: file,
        artifacts: payload.artifacts,
      })
    } catch (err) {
      setError(errorMessage(err, 'Unable to transcribe this file.'))
    } finally {
      setIsProcessing(false)
    }
  }

  const cancelQueued = async () => {
    if (!queuedJobId) return
    await cancelJob(queuedJobId).catch(() => undefined)
    setQueuedJobId(null)
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setAudioUrl(null)
  }

  if (queuedJobId && job) {
    return (
      <section className="input-section" aria-labelledby="upload-title">
        <div className="section-heading">
          <span>Audio file</span>
          <MarqueeTitle id="upload-title" text={job.source_name} />
        </div>
        <div className="form-stack">
          {audioUrl && <InlinePlayback src={audioUrl} />}
          <p className="file-summary">
            {job.status === 'processing'
              ? `Transcribing now${queueStatus?.worker_state ? ` (${queueStatus.worker_state} worker)` : ''}...`
              : queueStatus?.worker_state === 'offline'
                ? 'Transcription server is temporarily offline. Your job remains safely queued and will run automatically once it reconnects.'
                : queueStatus?.queue_position
                  ? `Position ${queueStatus.queue_position} in the queue${queueStatus.estimated_wait_seconds ? `, about ${formatDuration(queueStatus.estimated_wait_seconds)} wait` : ''}`
                  : 'Queued...'}
          </p>
          <ProgressMeter active estimatedSeconds={estimateProcessingSeconds(audioDuration)} />
          {['queued', 'retrying'].includes(job.status) && (
            <button type="button" className="secondary-action" onClick={cancelQueued}>Cancel</button>
          )}
        </div>
      </section>
    )
  }

  return (
    <section className="input-section" aria-labelledby="upload-title">
      <div className="section-heading">
        <span>Audio file</span>
        <h1 id="upload-title">Select audio</h1>
      </div>

      <div className="form-stack">
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          className="visually-hidden"
          onChange={(event) => {
            setFile(event.target.files?.[0] || null)
            setError('')
          }}
        />

        <button
          type="button"
          className="upload-dropzone"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            const nextFile = event.dataTransfer.files?.[0]
            if (nextFile) setFile(nextFile)
            setError('')
          }}
        >
          <span className="upload-icon" aria-hidden="true">
            <MusicUploadIcon />
          </span>
          <strong>{file ? file.name : 'Drop audio here or browse'}</strong>
          <small>{file ? formatBytes(file.size) : 'MP3, WAV, FLAC, OGG, M4A or AAC'}</small>
        </button>

        {asyncJobsEnabled && (
          <ProcessingOptions
            mode={processingMode}
            onModeChange={setProcessingMode}
            communityAvailable={communityAvailable}
            storageMode={sessionStorageMode}
            onStorageModeChange={setSessionStorageMode}
            keepAudioLocally={keepAudioLocally}
            onKeepAudioLocallyChange={setKeepAudioLocally}
            keepDataLocally={keepDataLocally}
            onKeepDataLocallyChange={setKeepDataLocally}
          />
        )}

        {error && <p className="form-error">{error}</p>}
        <ProgressMeter
          active={isProcessing}
          estimatedSeconds={estimateProcessingSeconds(audioDuration)}
        />

        <button
          type="button"
          className="primary-action"
          disabled={!file || isProcessing}
          onClick={handleSubmit}
        >
          {isProcessing ? 'Transcribing' : 'Transcribe'}
        </button>
      </div>
    </section>
  )
}

function MusicUploadIcon() {
  return (
    <svg viewBox="0 0 32 32" focusable="false">
      <path d="M12 22.6V8.2l10-2.1v12.8" />
      <path d="M12 12.2 22 10" />
      <path d="M9.9 24.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z" />
      <path d="M19.9 20.7a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z" />
      <path d="M16 27.2v-6.4" />
      <path d="m12.8 23.9 3.2-3.2 3.2 3.2" />
    </svg>
  )
}
