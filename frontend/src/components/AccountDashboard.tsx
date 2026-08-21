import { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { clearAllLocalAudio, getLocalAudio } from '../services/audioCache'
import {
  beginVolunteerPairing,
  cancelJob,
  getQueueStatus,
  GuitaricaJob,
  GuitaricaNotification,
  initializeGuitaricaAccount,
  listJobs,
  listMyVolunteerWorkers,
  listNotifications,
  markNotificationRead,
  QueueStatus,
  queueUpload,
  queueYoutube,
  restoreJob,
  revokeMyVolunteerWorker,
  subscribeToAccount,
  VolunteerPairing,
  VolunteerWorker,
} from '../services/jobStore'
import { clearAllLocalHistory, deleteLocalHistory, LocalHistoryEntry, listLocalHistory } from '../services/localHistoryCache'
import { TranscriptionResult } from '../types/transcription'
import { formatDuration } from '../utils/formatTranscription'

interface Props {
  session: Session
  onBack: () => void
  onOpenResult: (result: TranscriptionResult) => void
  onSignOut: () => void
  onOpenAdmin: () => void
  isAdmin: boolean
}

type Section = 'overview' | 'transcriptions' | 'notifications' | 'volunteer' | 'account'
type HistorySource = 'cloud' | 'device'

// Off until volunteer devices run a packaged inference artifact instead of
// your raw source + model weights -- see docs/deployment/VOLUNTEER_WORKERS.md.
const VOLUNTEER_FEATURE_ENABLED = import.meta.env.VITE_VOLUNTEER_WORKERS_ENABLED === 'true'

export default function AccountDashboard({ session, onBack, onOpenResult, onSignOut, onOpenAdmin, isAdmin }: Props) {
  const [section, setSection] = useState<Section>('overview')
  const [jobs, setJobs] = useState<GuitaricaJob[]>([])
  const [notifications, setNotifications] = useState<GuitaricaNotification[]>([])
  const [queue, setQueue] = useState<QueueStatus | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [volunteers, setVolunteers] = useState<VolunteerWorker[]>([])
  const [pairing, setPairing] = useState<VolunteerPairing | null>(null)
  const [volunteerError, setVolunteerError] = useState('')
  const [localHistory, setLocalHistory] = useState<LocalHistoryEntry[]>([])
  const [syncingJobId, setSyncingJobId] = useState<string | null>(null)
  const [localError, setLocalError] = useState('')
  const [historySource, setHistorySource] = useState<HistorySource>('cloud')

  const refresh = useCallback(async () => {
    try {
      await initializeGuitaricaAccount()
      const nextJobs = await listJobs()
      const firstActive = nextJobs.find((job) => ['queued', 'retrying', 'processing'].includes(job.status))
      const [nextNotifications, nextQueue] = await Promise.all([
        listNotifications(),
        getQueueStatus(firstActive?.id),
      ])
      setJobs(nextJobs)
      setNotifications(nextNotifications)
      setQueue(nextQueue)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your account.')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshLocalHistory = useCallback(() => {
    listLocalHistory().then(setLocalHistory).catch(() => undefined)
  }, [])

  useEffect(() => {
    void refresh()
    void refreshLocalHistory()
    return subscribeToAccount(session.user.id, () => { void refresh() })
  }, [refresh, refreshLocalHistory, session.user.id])

  const refreshVolunteers = useCallback(async () => {
    try {
      setVolunteers(await listMyVolunteerWorkers())
      setVolunteerError('')
    } catch (err) {
      setVolunteerError(err instanceof Error ? err.message : 'Could not load volunteer devices.')
    }
  }, [])

  useEffect(() => {
    if (section === 'volunteer') void refreshVolunteers()
  }, [section, refreshVolunteers])

  const generatePairingCode = async () => {
    try {
      setPairing(await beginVolunteerPairing())
      setVolunteerError('')
    } catch (err) {
      setVolunteerError(err instanceof Error ? err.message : 'Could not create a pairing code.')
    }
  }

  const revokeVolunteer = async (workerId: string) => {
    try {
      await revokeMyVolunteerWorker(workerId)
      await refreshVolunteers()
    } catch (err) {
      setVolunteerError(err instanceof Error ? err.message : 'Could not remove this device.')
    }
  }

  const completed = useMemo(() => jobs.filter((job) => job.status === 'completed'), [jobs])
  const active = useMemo(() => jobs.filter((job) => ['queued', 'retrying', 'processing'].includes(job.status)), [jobs])
  const unread = notifications.filter((item) => !item.read_at).length

  const openJob = async (job: GuitaricaJob) => {
    if (job.status !== 'completed') return
    const result = await restoreJob(job)
    if (result) onOpenResult(result)
  }

  const openLocalEntry = async (entry: LocalHistoryEntry) => {
    const cachedAudio = entry.hasLocalAudio ? await getLocalAudio(entry.jobId).catch(() => null) : null
    onOpenResult({
      ...entry.result,
      audioUrl: cachedAudio ? URL.createObjectURL(cachedAudio) : null,
      sourceFile: cachedAudio,
    })
  }

  // Local-only jobs never kept a server-side row past their retention
  // window, so "syncing" one can't resume the old job -- it re-submits the
  // cached source as a brand new one. YouTube keeps the original URL in its
  // source metadata (see worker.py's webpage_url); uploads need the cached
  // audio bytes, so without a local audio copy there's nothing to resubmit.
  const syncLocalEntry = async (entry: LocalHistoryEntry) => {
    setLocalError('')
    setSyncingJobId(entry.jobId)
    try {
      if (entry.sourceKind === 'youtube' && entry.result.source.url) {
        await queueYoutube(entry.result.source.url, entry.result.metadata.duration)
      } else {
        const cachedAudio = await getLocalAudio(entry.jobId)
        if (!cachedAudio) throw new Error('No local audio copy to upload -- this entry was saved without one.')
        const file = new File([cachedAudio], entry.sourceName, { type: cachedAudio.type || 'audio/mpeg' })
        await queueUpload(file, entry.result.metadata.duration, session, false)
      }
      await refresh()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not sync this entry to your account.')
    } finally {
      setSyncingJobId(null)
    }
  }

  const removeLocalEntry = async (jobId: string) => {
    await deleteLocalHistory(jobId).catch(() => undefined)
    refreshLocalHistory()
  }

  return (
    <section className="dashboard" aria-label="Guitarica account">
      <header className="dashboard-heading">
        <div>
          <span>Guitarica account</span>
          <h1>{displayName(session)}</h1>
        </div>
        <button type="button" className="text-command" onClick={onBack}>Back to studio</button>
      </header>

      <div className="dashboard-layout">
        <nav className="dashboard-nav" aria-label="Account sections">
          {(['overview', 'transcriptions', 'notifications', ...(VOLUNTEER_FEATURE_ENABLED ? ['volunteer' as const] : []), 'account'] as Section[]).map((item) => (
            <button key={item} type="button" className={section === item ? 'active' : ''} onClick={() => setSection(item)}>
              {item}<small>{item === 'notifications' && unread ? unread : ''}</small>
            </button>
          ))}
          {isAdmin && <button type="button" onClick={onOpenAdmin}>Admin</button>}
        </nav>

        <div className="dashboard-content">
          {error && <p className="form-error">{error}</p>}
          {loading && <p className="dashboard-muted">Loading account...</p>}

          {!loading && section === 'overview' && (
            <>
              <div className="dashboard-stats">
                <Metric label="Completed" value={completed.length} />
                <Metric label="In queue" value={active.length} />
                <Metric label="Notes mapped" value={completed.reduce((sum, job) => sum + Number(job.output_metrics?.detected_notes || 0), 0)} />
                <Metric label="Server" value={queue?.worker_state === 'offline' ? 'Offline' : 'Ready'} />
              </div>
              <SectionHeading title="Current work" aside={queue?.worker_state === 'offline' ? 'Worker offline. Your jobs remain safely queued.' : queue?.queue_position ? `Position ${queue.queue_position} / about ${formatDuration(queue.estimated_wait_seconds || 0)} wait` : `${queue?.queued_jobs || 0} queued`} />
              <JobList jobs={active.slice(0, 5)} onOpen={openJob} onCancel={async (id) => { await cancelJob(id); await refresh() }} empty="Nothing is waiting right now." />
              <SectionHeading title="Recent transcriptions" aside={`${completed.length} ready`} />
              <JobList jobs={completed.slice(0, 6)} onOpen={openJob} empty="Your completed transcriptions will appear here." />
            </>
          )}

          {!loading && section === 'transcriptions' && (
            <>
              <SectionHeading
                title="Transcriptions"
                aside={historySource === 'cloud' ? `${jobs.length} total` : `${localHistory.length} on this device`}
              />
              <div className="history-source-toggle" role="tablist" aria-label="Where to look">
                <button type="button" role="tab" aria-selected={historySource === 'cloud'} className={historySource === 'cloud' ? 'active' : ''} onClick={() => setHistorySource('cloud')}>
                  In your account <small>{jobs.length}</small>
                </button>
                <button type="button" role="tab" aria-selected={historySource === 'device'} className={historySource === 'device' ? 'active' : ''} onClick={() => setHistorySource('device')}>
                  On this device only <small>{localHistory.length}</small>
                </button>
              </div>
              {historySource === 'cloud' ? (
                <JobList jobs={jobs} onOpen={openJob} onCancel={async (id) => { await cancelJob(id); await refresh() }} empty="No transcriptions yet." />
              ) : (
                <>
                  {localError && <p className="form-error">{localError}</p>}
                  <LocalHistoryList
                    entries={localHistory}
                    syncingJobId={syncingJobId}
                    onOpen={openLocalEntry}
                    onSync={syncLocalEntry}
                    onRemove={removeLocalEntry}
                  />
                </>
              )}
            </>
          )}

          {!loading && section === 'notifications' && (
            <>
              <SectionHeading title="Notifications" aside={`${unread} unread`} />
              <div className="notification-list">
                {notifications.map((item) => (
                  <button key={item.id} type="button" className={item.read_at ? '' : 'unread'} onClick={async () => { await markNotificationRead(item.id); await refresh() }}>
                    <span><strong>{item.title}</strong><small>{item.body}</small></span>
                    <time>{formatDate(item.created_at)}</time>
                  </button>
                ))}
                {!notifications.length && <p className="dashboard-muted">No notifications yet.</p>}
              </div>
            </>
          )}

          {!loading && section === 'volunteer' && (
            <>
              <SectionHeading title="Volunteer this device" aside={`${volunteers.length} registered`} />
              <p className="dashboard-muted">
                Opt one of your own devices into the community processing pool. It only ever runs jobs whose
                owners explicitly allowed it (the checkbox on Upload), only handles uploaded audio files (never
                YouTube), and an admin must approve it before it starts. You can remove it at any time.
              </p>
              {volunteerError && <p className="form-error">{volunteerError}</p>}

              {!pairing && (
                <button type="button" className="primary-action" onClick={generatePairingCode}>
                  Generate pairing code
                </button>
              )}
              {pairing && (
                <div className="pairing-code-box">
                  <strong>{pairing.code}</strong>
                  <p>
                    On the machine you want to volunteer, run:
                    <br />
                    <code>run.bat volunteer-register {pairing.code}</code>
                  </p>
                  <small>Expires {formatDate(pairing.expiresAt)}. One-time use.</small>
                </div>
              )}

              <SectionHeading title="Your devices" aside="" />
              <div className="admin-table volunteer-table">
                {volunteers.map((worker) => (
                  <div key={worker.worker_id}>
                    <span className={`job-status status-${worker.status === 'active' ? 'completed' : worker.status === 'pending' ? 'queued' : 'failed'}`}>{worker.status}</span>
                    <span><strong>{worker.label}</strong><small>{worker.worker_id}</small></span>
                    <span>{worker.jobs_completed} completed / {worker.jobs_failed} failed</span>
                    <time>{worker.last_seen_at ? formatDate(worker.last_seen_at) : 'Never connected'}</time>
                    {worker.status !== 'revoked' && (
                      <button type="button" className="row-action" onClick={() => revokeVolunteer(worker.worker_id)}>Remove</button>
                    )}
                  </div>
                ))}
                {!volunteers.length && <p className="dashboard-muted">No volunteer devices yet.</p>}
              </div>
            </>
          )}

          {!loading && section === 'account' && (
            <>
              <SectionHeading title="Account" aside={isAdmin ? 'Administrator' : 'Member'} />
              <dl className="account-details">
                <div><dt>Email</dt><dd>{session.user.email}</dd></div>
                <div><dt>Joined</dt><dd>{formatDate(session.user.created_at)}</dd></div>
              </dl>
              <details className="account-advanced">
                <summary>Advanced details</summary>
                <dl className="account-details">
                  <div><dt>User ID</dt><dd>{session.user.id}</dd></div>
                  <div><dt>Storage</dt><dd>Inputs 7 days, results 30 days</dd></div>
                  <div><dt>On this device</dt><dd>Audio and/or transcription data for jobs you chose to store locally -- see Transcriptions -- kept in this browser only</dd></div>
                </dl>
              </details>
              <button type="button" className="text-command" style={{ marginRight: 24 }} onClick={() => { void clearAllLocalAudio() }}>Clear local audio cache</button>
              <button type="button" className="text-command" style={{ marginRight: 24 }} onClick={() => { void clearAllLocalHistory().then(refreshLocalHistory) }}>Clear local transcription cache</button>
              <button type="button" className="text-command danger" onClick={onSignOut}>Sign out</button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function JobList({ jobs, onOpen, onCancel, empty }: { jobs: GuitaricaJob[]; onOpen: (job: GuitaricaJob) => void; onCancel?: (id: string) => void; empty: string }) {
  if (!jobs.length) return <p className="dashboard-muted">{empty}</p>
  return <div className="job-list">{jobs.map((job) => (
    <article key={job.id} className="job-row">
      <button type="button" className="job-main" disabled={job.status !== 'completed'} onClick={() => onOpen(job)}>
        <span className={`job-status status-${job.status}`}>{job.status}</span>
        <span><strong>{job.source_name}</strong><small>{job.source_kind} / {formatDate(job.created_at)}</small></span>
        <span className="job-metric">{job.metadata?.duration ? formatDuration(Number(job.metadata.duration)) : job.estimated_processing_seconds ? `~${formatDuration(job.estimated_processing_seconds)} estimate` : `${job.progress}%`}</span>
        <span className="job-metric">{job.output_metrics?.detected_notes ? `${job.output_metrics.detected_notes} notes` : job.model_version || 'Awaiting model'}</span>
      </button>
      {onCancel && ['queued', 'retrying'].includes(job.status) && <button type="button" className="row-action" onClick={() => onCancel(job.id)}>Cancel</button>}
      {job.error_message && <p className="job-error">{job.error_message}</p>}
    </article>
  ))}</div>
}

function LocalHistoryList({
  entries,
  syncingJobId,
  onOpen,
  onSync,
  onRemove,
}: {
  entries: LocalHistoryEntry[]
  syncingJobId: string | null
  onOpen: (entry: LocalHistoryEntry) => void
  onSync: (entry: LocalHistoryEntry) => void
  onRemove: (jobId: string) => void
}) {
  if (!entries.length) return <p className="dashboard-muted">Nothing stored locally. Choose "Store audio locally" or "Keep on this device only" before transcribing to add entries here.</p>
  return <div className="job-list">{entries.map((entry) => (
    <article key={entry.jobId} className="job-row">
      <button type="button" className="job-main" onClick={() => onOpen(entry)}>
        <span className="job-status status-completed">local</span>
        <span><strong>{entry.sourceName}</strong><small>{entry.sourceKind} / {formatDate(entry.createdAt)}</small></span>
        <span className="job-metric">{entry.result.metadata?.duration ? formatDuration(Number(entry.result.metadata.duration)) : ''}</span>
        <span className="job-metric">{entry.hasLocalAudio ? 'Audio + data' : 'Data only'}</span>
      </button>
      <button type="button" className="row-action" disabled={syncingJobId === entry.jobId} onClick={() => onSync(entry)}>
        {syncingJobId === entry.jobId ? 'Syncing...' : 'Sync to account'}
      </button>
      <button type="button" className="row-action" onClick={() => onRemove(entry.jobId)}>Remove</button>
    </article>
  ))}</div>
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function SectionHeading({ title, aside }: { title: string; aside: string }) {
  return <div className="dashboard-section-heading"><h2>{title}</h2><span>{aside}</span></div>
}

function displayName(session: Session) {
  return session.user.user_metadata?.name || session.user.user_metadata?.username || session.user.email?.split('@')[0] || 'Account'
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
