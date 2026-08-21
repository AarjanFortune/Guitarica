import { useEffect, useState } from 'react'
import { Session } from '@supabase/supabase-js'
import useQueuedJob from '../hooks/useQueuedJob'
import { saveAudioLocally } from '../services/audioCache'
import { cancelJob, expireMyJobNow, fetchSourceAudio, queueYoutube, restoreJob } from '../services/jobStore'
import { saveLocalHistory } from '../services/localHistoryCache'
import { fetchYoutubeMetadata, transcribeYoutube } from '../services/transcriptionApi'
import { TranscriptionResult } from '../types/transcription'
import { errorMessage, formatDuration, mapBackendNotes } from '../utils/formatTranscription'
import { estimateProcessingSeconds } from '../utils/processingEstimate'
import InlinePlayback from './InlinePlayback'
import MarqueeTitle from './MarqueeTitle'
import ProcessingOptions from './ProcessingOptions'
import ProgressMeter from './ProgressMeter'
import { SessionStorageMode } from './SessionStoragePreference'

interface YouTubePanelProps {
  onComplete: (result: TranscriptionResult) => void
  session: Session | null
}

export default function YouTubePanel({ onComplete, session }: YouTubePanelProps) {
  const [url, setUrl] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [estimatedSeconds, setEstimatedSeconds] = useState<number | undefined>()
  const [error, setError] = useState('')
  const [queuedJobId, setQueuedJobId] = useState<string | null>(null)
  const [sourceAudio, setSourceAudio] = useState<Blob | null>(null)
  const [sourceAudioUrl, setSourceAudioUrl] = useState<string | null>(null)
  const [sessionStorageMode, setSessionStorageMode] = useState<SessionStorageMode>('cloud')
  const [keepAudioLocally, setKeepAudioLocally] = useState(false)
  const [keepDataLocally, setKeepDataLocally] = useState(false)
  const { job, queueStatus } = useQueuedJob(queuedJobId)

  useEffect(() => {
    if (!job) return
    if (job.status === 'completed') {
      restoreJob(job).then(async (result) => {
        // This browser already pulled the real audio into memory the
        // moment it was extracted -- that's available for this session
        // either way, whether or not "keep local copy" ends up saving it
        // to IndexedDB for future sessions too.
        if (result) onComplete({ ...result, sourceFile: result.sourceFile || sourceAudio })
        if (result && (sessionStorageMode === 'ephemeral' || keepDataLocally)) {
          const { audioUrl: _audioUrl, sourceFile: _sourceFile, ...rest } = result
          await saveLocalHistory({
            jobId: job.id,
            sourceKind: 'youtube',
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

  // The worker extracts and uploads the real audio to a temporary storage
  // relay while transcription is still running, well before the job
  // completes. This only fires once -- source_audio_path goes from null to
  // a fixed value and stays there, so it doesn't refetch on every 3s status
  // poll. Pulling the actual bytes (not just a link) into memory here is
  // what makes playback keep working after this signed link would
  // otherwise have expired, and after the relay copy is reclaimed.
  useEffect(() => {
    if (!job?.source_audio_path) return
    const shouldKeepLocalCopy = sessionStorageMode === 'ephemeral' || keepAudioLocally
    fetchSourceAudio(job).then((blob) => {
      setSourceAudio(blob)
      // Saved as soon as it's in hand, not gated on job completion -- this is
      // what makes the "Ben 10" case work: reopening the job later from
      // Account history calls restoreJob, which can only offer a playable
      // copy if IndexedDB already has one by then.
      if (blob && shouldKeepLocalCopy) void saveAudioLocally(job.id, blob).catch(() => undefined)
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.source_audio_path])

  useEffect(() => {
    if (!sourceAudio) {
      setSourceAudioUrl(null)
      return undefined
    }
    const objectUrl = URL.createObjectURL(sourceAudio)
    setSourceAudioUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [sourceAudio])

  const handleSubmit = async () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) return

    setIsProcessing(true)
    setEstimatedSeconds(undefined)
    setError('')

    try {
      if (import.meta.env.VITE_ASYNC_JOBS_ENABLED === 'true') {
        if (!session) throw new Error('Sign in before adding work to the queue.')
        const queued = await queueYoutube(trimmedUrl, null)
        setSourceAudio(null)
        setQueuedJobId(queued.id)
        return
      }
      const metadata = await fetchYoutubeMetadata(trimmedUrl).catch(() => null)
      setEstimatedSeconds(estimateProcessingSeconds(metadata?.duration))
      const payload = await transcribeYoutube(trimmedUrl)
      if (!payload.audio_url) {
        throw new Error('Backend did not return playable audio for this result.')
      }
      onComplete({
        notes: mapBackendNotes(payload),
        metadata: payload.metadata,
        source: payload.source,
        audioUrl: payload.audio_url,
        artifacts: payload.artifacts,
      })
    } catch (err) {
      setError(errorMessage(err, 'Unable to process this YouTube link.'))
    } finally {
      setIsProcessing(false)
    }
  }

  const cancelQueued = async () => {
    if (!queuedJobId) return
    await cancelJob(queuedJobId).catch(() => undefined)
    setQueuedJobId(null)
    setSourceAudio(null)
  }

  if (queuedJobId && job) {
    return (
      <section className="input-section" aria-labelledby="youtube-title">
        <div className="section-heading">
          <span>YouTube</span>
          <MarqueeTitle id="youtube-title" text={job.source_name} />
        </div>
        <div className="form-stack">
          {sourceAudioUrl && <InlinePlayback src={sourceAudioUrl} />}
          <p className="file-summary">
            {job.status === 'processing'
              ? `Transcribing now${queueStatus?.worker_state ? ` (${queueStatus.worker_state} worker)` : ''}...`
              : queueStatus?.worker_state === 'offline'
                ? 'Transcription server is temporarily offline. Your job remains safely queued and will run automatically once it reconnects.'
                : queueStatus?.queue_position
                  ? `Position ${queueStatus.queue_position} in the queue${queueStatus.estimated_wait_seconds ? `, about ${formatDuration(queueStatus.estimated_wait_seconds)} wait` : ''}`
                  : 'Queued...'}
          </p>
          <ProgressMeter active estimatedSeconds={estimatedSeconds} />
          {['queued', 'retrying'].includes(job.status) && (
            <button type="button" className="secondary-action" onClick={cancelQueued}>Cancel</button>
          )}
        </div>
      </section>
    )
  }

  return (
    <section className="input-section" aria-labelledby="youtube-title">
      <div className="section-heading">
        <span>YouTube</span>
        <h1 id="youtube-title">Paste a link</h1>
      </div>

      <div className="form-stack">
        <label className="youtube-link-field">
          <span className="field-label">YouTube URL</span>
          <span className="youtube-input-line">
            <input
              type="url"
              className="text-input"
              placeholder="https://youtube.com/watch?v=..."
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setEstimatedSeconds(undefined)
                setError('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSubmit()
              }}
            />
          </span>
        </label>

        {import.meta.env.VITE_ASYNC_JOBS_ENABLED === 'true' && (
          <ProcessingOptions
            showProcessingMode={false}
            mode="guitarica"
            onModeChange={() => undefined}
            communityAvailable={false}
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
          estimatedSeconds={estimatedSeconds}
        />

        <button
          type="button"
          className="primary-action"
          disabled={!url.trim() || isProcessing}
          onClick={handleSubmit}
        >
          {isProcessing ? 'Transcribing' : 'Transcribe'}
        </button>
      </div>
    </section>
  )
}
