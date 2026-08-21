import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  adminBlockIdentity,
  AdminVolunteerWorker,
  adminGetPlatformSettings,
  adminGetUserKpis,
  AdminUserActivityRow,
  AdminUserKpis,
  adminListAuditLog,
  adminListUsersWithActivity,
  adminListVolunteerWorkers,
  adminListWorkers,
  AdminWorkerRow,
  adminSetPlatformSettings,
  adminSetVolunteerWorkerStatus,
  AuditLogEntry,
  GuitaricaJob,
  listJobs,
  restoreJob,
  retryJobAsAdmin,
} from '../services/jobStore'
import { supabase } from '../services/supabaseClient'
import { TranscriptionResult } from '../types/transcription'
import Toggle from '../ui/Toggle'
import { describeSettledFailure, formatDuration } from '../utils/formatTranscription'

interface Props { onOpenResult: (result: TranscriptionResult) => void }
type Section = 'operations' | 'jobs' | 'users' | 'workers' | 'volunteers' | 'audit'

const VOLUNTEER_FEATURE_ENABLED = import.meta.env.VITE_VOLUNTEER_WORKERS_ENABLED === 'true'
const SECTIONS: Section[] = ['operations', 'jobs', 'users', 'workers', ...(VOLUNTEER_FEATURE_ENABLED ? ['volunteers' as const] : []), 'audit']

export default function MobileAdminDashboard({ onOpenResult }: Props) {
  const [section, setSection] = useState<Section>('operations')
  const [jobs, setJobs] = useState<GuitaricaJob[]>([])
  const [profiles, setProfiles] = useState<AdminUserActivityRow[]>([])
  const [userKpis, setUserKpis] = useState<AdminUserKpis | null>(null)
  const [workers, setWorkers] = useState<AdminWorkerRow[]>([])
  const [volunteers, setVolunteers] = useState<AdminVolunteerWorker[]>([])
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([])
  const [communityProcessingEnabled, setCommunityProcessingEnabled] = useState(false)
  const [blockKind, setBlockKind] = useState<'ip' | 'device_fingerprint' | 'user'>('ip')
  const [blockValue, setBlockValue] = useState('')
  const [blockReason, setBlockReason] = useState('')
  const [error, setError] = useState('')

  // allSettled so one broken RPC (schema drift, an unapplied migration)
  // can't blank every section behind one opaque error -- see the same fix
  // in the desktop AdminDashboard for the incident this addresses.
  const refresh = useCallback(async () => {
    if (!supabase) return
    const [jobsResult, usersResult, kpisResult, workersResult, volunteersResult, settingsResult, auditResult] = await Promise.allSettled([
      listJobs(250),
      adminListUsersWithActivity(250),
      adminGetUserKpis(),
      adminListWorkers(),
      VOLUNTEER_FEATURE_ENABLED ? adminListVolunteerWorkers() : Promise.resolve([]),
      adminGetPlatformSettings(),
      adminListAuditLog(50),
    ])

    if (jobsResult.status === 'fulfilled') setJobs(jobsResult.value)
    if (usersResult.status === 'fulfilled') setProfiles(usersResult.value)
    if (kpisResult.status === 'fulfilled') setUserKpis(kpisResult.value)
    if (workersResult.status === 'fulfilled') setWorkers(workersResult.value)
    if (volunteersResult.status === 'fulfilled') setVolunteers(volunteersResult.value)
    if (settingsResult.status === 'fulfilled') setCommunityProcessingEnabled(settingsResult.value.communityProcessingEnabled)
    if (auditResult.status === 'fulfilled') setAuditLog(auditResult.value)

    const messages = [
      describeSettledFailure('jobs', jobsResult),
      describeSettledFailure('users', usersResult),
      describeSettledFailure('KPIs', kpisResult),
      describeSettledFailure('workers', workersResult),
      describeSettledFailure('volunteers', volunteersResult),
      describeSettledFailure('platform settings', settingsResult),
      describeSettledFailure('audit log', auditResult),
    ].filter((message): message is string => message !== null)
    setError(messages.join(' / '))
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const counts = useMemo(
    () => Object.fromEntries(['queued', 'processing', 'completed', 'failed'].map((status) => [status, jobs.filter((job) => job.status === status).length])),
    [jobs],
  )
  const profileById = useMemo(() => Object.fromEntries(profiles.map((profile) => [profile.user_id, profile])), [profiles])

  const openJob = async (job: GuitaricaJob) => {
    if (job.status !== 'completed') return
    const result = await restoreJob(job)
    if (result) onOpenResult(result)
  }

  const setVolunteerStatus = async (workerId: string, status: 'active' | 'suspended' | 'revoked') => {
    await adminSetVolunteerWorkerStatus(workerId, status)
    await refresh()
  }

  const submitBlock = async () => {
    if (!blockValue.trim()) return
    await adminBlockIdentity(blockKind, blockValue.trim(), blockReason.trim())
    setBlockValue('')
    setBlockReason('')
    await refresh()
  }

  const toggleCommunityProcessing = async (enabled: boolean) => {
    setCommunityProcessingEnabled(enabled)
    try {
      await adminSetPlatformSettings(enabled)
    } catch (err) {
      setCommunityProcessingEnabled(!enabled)
      setError(err instanceof Error ? err.message : 'Could not update the kill switch.')
    }
  }

  return (
    <div>
      <div className="m-tabs">
        {SECTIONS.map((item) => (
          <button key={item} type="button" className={section === item ? 'active' : ''} onClick={() => setSection(item)}>{item}</button>
        ))}
      </div>

      {error && <p className="m-error">{error}</p>}

      {section === 'operations' && (
        <>
          <div className="m-stat-grid">
            <div className="m-stat"><span>Queued</span><strong>{counts.queued || 0}</strong></div>
            <div className="m-stat"><span>Processing</span><strong>{counts.processing || 0}</strong></div>
            <div className="m-stat"><span>Completed</span><strong>{counts.completed || 0}</strong></div>
            <div className="m-stat"><span>Failed</span><strong>{counts.failed || 0}</strong></div>
          </div>
          <Toggle
            id="mobile-community-processing-toggle"
            checked={communityProcessingEnabled}
            onChange={toggleCommunityProcessing}
            label="Allow community hardware processing"
            description="Global kill switch. Stays off until packaged/encrypted worker distribution exists."
          />
          <p className="m-eyebrow" style={{ marginTop: 20 }}>Worker health</p>
          <WorkerRows workers={workers} />
        </>
      )}

      {section === 'jobs' && (
        <div className="m-list">
          {jobs.map((job) => (
            <div className="m-list-row" key={job.id}>
              <button type="button" className="m-row-main" style={{ background: 'none', border: 0, textAlign: 'left', padding: 0 }} disabled={job.status !== 'completed'} onClick={() => openJob(job)}>
                <strong>{job.source_name}</strong>
                <small>{profileById[job.user_id]?.email || job.user_id}</small>
              </button>
              <span className={`m-status-label status-${job.status}`}>{job.status}</span>
              {['failed', 'cancelled'].includes(job.status) && (
                <button type="button" className="m-link-button" onClick={async () => { await retryJobAsAdmin(job.id); await refresh() }}>Retry</button>
              )}
            </div>
          ))}
          {!jobs.length && <p className="m-empty">No jobs loaded.</p>}
        </div>
      )}

      {section === 'users' && (
        <>
          <div className="m-stat-grid">
            <div className="m-stat"><span>Total users</span><strong>{userKpis?.totalUsers ?? 0}</strong></div>
            <div className="m-stat"><span>New (7d)</span><strong>{userKpis?.newUsers7d ?? 0}</strong></div>
            <div className="m-stat"><span>Active (7d)</span><strong>{userKpis?.activeUsers7d ?? 0}</strong></div>
            <div className="m-stat"><span>Success rate</span><strong>{userKpis?.successRatePct != null ? `${userKpis.successRatePct}%` : '–'}</strong></div>
          </div>
          <div className="m-stat-grid">
            <div className="m-stat"><span>Total jobs</span><strong>{userKpis?.totalJobs ?? 0}</strong></div>
            <div className="m-stat"><span>Uploads</span><strong>{userKpis?.uploadJobs ?? 0}</strong></div>
            <div className="m-stat"><span>YouTube</span><strong>{userKpis?.youtubeJobs ?? 0}</strong></div>
            <div className="m-stat"><span>Avg. processing</span><strong>{userKpis?.avgProcessingSeconds != null ? formatDuration(userKpis.avgProcessingSeconds) : '–'}</strong></div>
          </div>
          <div className="m-list">
            {profiles.map((profile) => (
              <div className="m-list-row" key={profile.user_id}>
                <div className="m-row-main">
                  <strong>{profile.display_name || profile.email.split('@')[0]}</strong>
                  <small>{profile.email} · {profile.job_count} job{profile.job_count === 1 ? '' : 's'}{profile.failed_count ? ` · ${profile.failed_count} failed` : ''}</small>
                </div>
                <small>{profile.last_job_at ? new Date(profile.last_job_at).toLocaleDateString() : 'No jobs yet'}</small>
              </div>
            ))}
            {!profiles.length && <p className="m-empty">No users yet.</p>}
          </div>
        </>
      )}

      {section === 'workers' && <WorkerRows workers={workers} />}

      {section === 'volunteers' && (
        <>
          <div className="m-list">
            {volunteers.map((worker) => (
              <div className="m-list-row" key={worker.worker_id}>
                <div className="m-row-main">
                  <strong>{worker.label}</strong>
                  <small>{worker.worker_id} · owner {worker.owner_user_id.slice(0, 8)}</small>
                </div>
                <span className={`m-status-label status-${worker.status === 'active' ? 'active' : worker.status}`}>{worker.status}</span>
              </div>
            ))}
            {!volunteers.length && <p className="m-empty">No volunteer devices registered.</p>}
          </div>
          {volunteers.map((worker) => (
            <div key={worker.worker_id} style={{ display: 'flex', gap: 10, margin: '14px 0' }}>
              {worker.status !== 'active' && <button type="button" className="m-button secondary" onClick={() => setVolunteerStatus(worker.worker_id, 'active')}>Approve</button>}
              {worker.status === 'active' && <button type="button" className="m-button secondary" onClick={() => setVolunteerStatus(worker.worker_id, 'suspended')}>Suspend</button>}
              {worker.status !== 'revoked' && <button type="button" className="m-button danger" onClick={() => setVolunteerStatus(worker.worker_id, 'revoked')}>Revoke</button>}
            </div>
          ))}

          <p className="m-eyebrow" style={{ marginTop: 22 }}>Block an identity</p>
          <div className="m-block-form">
            <select className="m-input" value={blockKind} onChange={(event) => setBlockKind(event.target.value as typeof blockKind)}>
              <option value="ip">IP address</option>
              <option value="device_fingerprint">Device fingerprint</option>
              <option value="user">User ID</option>
            </select>
            <input className="m-input" type="text" placeholder="Value to block" value={blockValue} onChange={(event) => setBlockValue(event.target.value)} />
            <input className="m-input" type="text" placeholder="Reason (optional)" value={blockReason} onChange={(event) => setBlockReason(event.target.value)} />
            <button type="button" className="m-button danger" onClick={submitBlock}>Block</button>
          </div>
        </>
      )}

      {section === 'audit' && (
        <div className="m-list">
          {auditLog.map((entry) => (
            <div className="m-list-row" key={entry.id}>
              <div className="m-row-main">
                <strong>{entry.action}</strong>
                <small>{entry.target_type}{entry.target_id ? ` / ${entry.target_id}` : ''} · {entry.actor_user_id ? profileById[entry.actor_user_id]?.email || entry.actor_user_id.slice(0, 8) : 'system'}</small>
              </div>
              <small>{new Date(entry.created_at).toLocaleString()}</small>
            </div>
          ))}
          {!auditLog.length && <p className="m-empty">No audit entries yet.</p>}
        </div>
      )}
    </div>
  )
}

function WorkerRows({ workers }: { workers: AdminWorkerRow[] }) {
  return (
    <div className="m-list">
      {workers.map((worker) => (
        <div className="m-list-row" key={worker.worker_id}>
          <div className="m-row-main">
            <strong>{worker.label}</strong>
            <small>{worker.trust_tier} · {worker.gpu_name || 'GPU unknown'} · {worker.jobs_completed} completed</small>
          </div>
          <span className={`m-status-label status-${worker.status}`}>{worker.status}</span>
        </div>
      ))}
      {!workers.length && <p className="m-empty">No worker has checked in yet.</p>}
    </div>
  )
}
