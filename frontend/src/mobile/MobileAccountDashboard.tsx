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
  onOpenResult: (result: TranscriptionResult) => void
  onSignOut: () => void
}

type Section = 'overview' | 'jobs' | 'notifications' | 'volunteer' | 'settings'
type HistorySource = 'cloud' | 'device'

// Off until volunteer devices run a packaged inference artifact instead of
// your raw source + model weights -- see docs/deployment/VOLUNTEER_WORKERS.md.
const VOLUNTEER_FEATURE_ENABLED = import.meta.env.VITE_VOLUNTEER_WORKERS_ENABLED === 'true'
const SECTIONS: Section[] = ['overview', 'jobs', 'notifications', ...(VOLUNTEER_FEATURE_ENABLED ? ['volunteer' as const] : []), 'settings']

export default function MobileAccountDashboard({ session, onOpenResult, onSignOut }: Props) {
  const [section, setSection] = useState<Section>('overview')
  const [jobs, setJobs] = useState<GuitaricaJob[]>([])
  const [notifications, setNotifications] = useState<GuitaricaNotification[]>([])
  const [queue, setQueue] = useState<QueueStatus | null>(null)
  const [volunteers, setVolunteers] = useState<VolunteerWorker[]>([])
  const [pairing, setPairing] = useState<VolunteerPairing | null>(null)
  const [error, setError] = useState('')
  const [localHistory, setLocalHistory] = useState<LocalHistoryEntry[]>([])
  const [syncingJobId, setSyncingJobId] = useState<string | null>(null)
  const [historySource, setHistorySource] = useState<HistorySource>('cloud')

  const refresh = useCallback(async () => {
    try {
      await initializeGuitaricaAccount()
      const nextJobs = await listJobs()
      const firstActive = nextJobs.find((job) => ['queued', 'retrying', 'processing'].includes(job.status))
      const [nextNotifications, nextQueue] = await Promise.all([listNotifications(), getQueueStatus(firstActive?.id)])
      setJobs(nextJobs)
      setNotifications(nextNotifications)
      setQueue(nextQueue)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your account.')
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

  useEffect(() => {
    if (section === 'volunteer') {
      listMyVolunteerWorkers().then(setVolunteers).catch(() => undefined)
    }
  }, [section])

  const active = useMemo(() => jobs.filter((job) => ['queued', 'retrying', 'processing'].includes(job.status)), [jobs])
  const completed = useMemo(() => jobs.filter((job) => job.status === 'completed'), [jobs])
  const unread = notifications.filter((item) => !item.read_at).length

  const openJob = async (job: GuitaricaJob) => {
    if (job.status !== 'completed') return
    const result = await restoreJob(job)
    if (result) onOpenResult(result)
  }

  const openLocalEntry = async (entry: LocalHistoryEntry) => {
    const cachedAudio = entry.hasLocalAudio ? await getLocalAudio(entry.jobId).catch(() => null) : null
    onOpenResult({ ...entry.result, audioUrl: cachedAudio ? URL.createObjectURL(cachedAudio) : null, sourceFile: cachedAudio })
  }

  const syncLocalEntry = async (entry: LocalHistoryEntry) => {
    setSyncingJobId(entry.jobId)
    try {
      if (entry.sourceKind === 'youtube' && entry.result.source.url) {
        await queueYoutube(entry.result.source.url, entry.result.metadata.duration)
      } else {
        const cachedAudio = await getLocalAudio(entry.jobId)
        if (!cachedAudio) throw new Error('No local audio copy to upload.')
        const file = new File([cachedAudio], entry.sourceName, { type: cachedAudio.type || 'audio/mpeg' })
        await queueUpload(file, entry.result.metadata.duration, session, false)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sync this entry to your account.')
    } finally {
      setSyncingJobId(null)
    }
  }

  const removeLocalEntry = async (jobId: string) => {
    await deleteLocalHistory(jobId).catch(() => undefined)
    refreshLocalHistory()
  }

  const generatePairing = async () => {
    try { setPairing(await beginVolunteerPairing()) } catch (err) { setError(err instanceof Error ? err.message : 'Could not create a pairing code.') }
  }

  return (
    <div>
      <div className="m-tabs">
        {SECTIONS.map((item) => (
          <button key={item} type="button" className={section === item ? 'active' : ''} onClick={() => setSection(item)}>
            {item === 'notifications' && unread > 0 ? `Notifications (${unread})` : item}
          </button>
        ))}
      </div>

      {error && <p className="m-error">{error}</p>}

      {section === 'overview' && (
        <>
          <div className="m-stat-grid">
            <div className="m-stat"><span>Completed</span><strong>{completed.length}</strong></div>
            <div className="m-stat"><span>In queue</span><strong>{active.length}</strong></div>
            <div className="m-stat"><span>Server</span><strong style={{ fontSize: '1.1rem' }}>{queue?.worker_state === 'offline' ? 'Offline' : 'Ready'}</strong></div>
            <div className="m-stat"><span>Wait</span><strong style={{ fontSize: '1.1rem' }}>{queue?.estimated_wait_seconds ? formatDuration(queue.estimated_wait_seconds) : '—'}</strong></div>
          </div>
          <JobRows jobs={active.slice(0, 5)} onOpen={openJob} empty="Nothing is waiting right now." />
        </>
      )}

      {section === 'jobs' && (
        <>
          <div className="m-tabs" style={{ margin: '0 0 16px' }} role="tablist" aria-label="Where to look">
            <button type="button" role="tab" aria-selected={historySource === 'cloud'} className={historySource === 'cloud' ? 'active' : ''} onClick={() => setHistorySource('cloud')}>
              In your account ({jobs.length})
            </button>
            <button type="button" role="tab" aria-selected={historySource === 'device'} className={historySource === 'device' ? 'active' : ''} onClick={() => setHistorySource('device')}>
              On this device ({localHistory.length})
            </button>
          </div>
          {historySource === 'cloud' ? (
            <JobRows jobs={jobs} onOpen={openJob} onCancel={async (id) => { await cancelJob(id); await refresh() }} empty="No transcriptions yet." />
          ) : (
            <LocalHistoryRows entries={localHistory} syncingJobId={syncingJobId} onOpen={openLocalEntry} onSync={syncLocalEntry} onRemove={removeLocalEntry} />
          )}
        </>
      )}

      {section === 'notifications' && (
        <div className="m-list">
          {notifications.map((item) => (
            <button key={item.id} type="button" className="m-list-row" onClick={async () => { await markNotificationRead(item.id); await refresh() }}>
              <div className="m-row-main"><strong>{item.title}</strong><small>{item.body}</small></div>
              {!item.read_at && <span className="m-status-label status-active">New</span>}
            </button>
          ))}
          {!notifications.length && <p className="m-empty">No notifications yet.</p>}
        </div>
      )}

      {section === 'volunteer' && (
        <>
          <p className="m-muted" style={{ marginBottom: 20 }}>
            Opt one of your own devices into the community processing pool. It only runs jobs whose owners allowed
            it, only handles uploaded files, and needs admin approval before it starts.
          </p>
          {!pairing && <button type="button" className="m-button" onClick={generatePairing}>Generate pairing code</button>}
          {pairing && (
            <div style={{ margin: '4px 0 20px' }}>
              <strong style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: '1.6rem', letterSpacing: '0.06em' }}>{pairing.code}</strong>
              <p className="m-muted" style={{ margin: '8px 0' }}>On the device you want to volunteer, run:</p>
              <code style={{ fontSize: '0.8rem' }}>run.bat volunteer-register {pairing.code}</code>
            </div>
          )}
          <p className="m-eyebrow" style={{ marginTop: 4 }}>Your devices</p>
          <div className="m-list">
            {volunteers.map((worker) => (
              <div className="m-list-row" key={worker.worker_id}>
                <div className="m-row-main"><strong>{worker.label}</strong><small>{worker.jobs_completed} completed / {worker.jobs_failed} failed</small></div>
                <span className={`m-status-label status-${worker.status === 'active' ? 'active' : worker.status}`}>{worker.status}</span>
              </div>
            ))}
            {!volunteers.length && <p className="m-empty">No volunteer devices yet.</p>}
          </div>
          {volunteers.filter((worker) => worker.status !== 'revoked').map((worker) => (
            <button key={worker.worker_id} type="button" className="m-button danger" style={{ marginTop: 20 }} onClick={async () => { await revokeMyVolunteerWorker(worker.worker_id); listMyVolunteerWorkers().then(setVolunteers) }}>
              Remove {worker.label}
            </button>
          ))}
        </>
      )}

      {section === 'settings' && (
        <>
          <div className="m-list">
            <div className="m-list-row"><div className="m-row-main"><strong>Email</strong></div><small>{session.user.email}</small></div>
            <div className="m-list-row"><div className="m-row-main"><strong>Joined</strong></div><small>{new Date(session.user.created_at).toLocaleDateString()}</small></div>
            <div className="m-list-row"><div className="m-row-main"><strong>Storage</strong></div><small>Inputs 7 days, results 30 days</small></div>
          </div>
          <button type="button" className="m-button secondary" style={{ marginTop: 20 }} onClick={() => { void clearAllLocalAudio() }}>Clear local audio cache</button>
          <button type="button" className="m-button secondary" style={{ marginTop: 12 }} onClick={() => { void clearAllLocalHistory().then(refreshLocalHistory) }}>Clear local transcription cache</button>
          <button type="button" className="m-button danger" style={{ marginTop: 12 }} onClick={onSignOut}>Sign out</button>
        </>
      )}
    </div>
  )
}

function JobRows({ jobs, onOpen, onCancel, empty }: { jobs: GuitaricaJob[]; onOpen: (job: GuitaricaJob) => void; onCancel?: (id: string) => void; empty: string }) {
  if (!jobs.length) return <p className="m-empty">{empty}</p>
  return (
    <div className="m-list">
      {jobs.map((job) => (
        <div className="m-list-row" key={job.id}>
          <button type="button" className="m-row-main" style={{ background: 'none', border: 0, textAlign: 'left', padding: 0 }} disabled={job.status !== 'completed'} onClick={() => onOpen(job)}>
            <strong>{job.source_name}</strong>
            <small>{job.source_kind} · {new Date(job.created_at).toLocaleDateString()}</small>
          </button>
          <span className={`m-status-label status-${job.status}`}>{job.status}</span>
          {onCancel && ['queued', 'retrying'].includes(job.status) && (
            <button type="button" className="m-link-button" onClick={() => onCancel(job.id)}>Cancel</button>
          )}
        </div>
      ))}
    </div>
  )
}

function LocalHistoryRows({
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
  if (!entries.length) return <p className="m-empty">Nothing stored locally yet.</p>
  return (
    <div className="m-list">
      {entries.map((entry) => (
        <div className="m-list-row" key={entry.jobId}>
          <button type="button" className="m-row-main" style={{ background: 'none', border: 0, textAlign: 'left', padding: 0 }} onClick={() => onOpen(entry)}>
            <strong>{entry.sourceName}</strong>
            <small>{entry.sourceKind} · {new Date(entry.createdAt).toLocaleDateString()} · {entry.hasLocalAudio ? 'audio + data' : 'data only'}</small>
          </button>
          <button type="button" className="m-link-button" disabled={syncingJobId === entry.jobId} onClick={() => onSync(entry)}>
            {syncingJobId === entry.jobId ? 'Syncing...' : 'Sync'}
          </button>
          <button type="button" className="m-link-button" onClick={() => onRemove(entry.jobId)}>Remove</button>
        </div>
      ))}
    </div>
  )
}
