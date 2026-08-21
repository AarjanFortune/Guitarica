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

interface Props { onBack: () => void; onOpenResult: (result: TranscriptionResult) => void }
type Section = 'operations' | 'jobs' | 'users' | 'workers' | 'volunteers' | 'audit'

const VOLUNTEER_FEATURE_ENABLED = import.meta.env.VITE_VOLUNTEER_WORKERS_ENABLED === 'true'

export default function AdminDashboard({ onBack, onOpenResult }: Props) {
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

  // Each panel loads independently -- a single broken RPC (a schema drift,
  // a not-yet-applied migration) used to reject the whole Promise.all and
  // blank every section behind an opaque error, including ones that had
  // nothing to do with the failure. allSettled keeps every section that
  // succeeded on screen and reports only the ones that actually failed.
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

  const counts = useMemo(() => Object.fromEntries(['queued', 'processing', 'completed', 'failed'].map((status) => [status, jobs.filter((job) => job.status === status).length])), [jobs])
  const profileById = useMemo(() => Object.fromEntries(profiles.map((profile) => [profile.user_id, profile])), [profiles])

  const openJob = async (job: GuitaricaJob) => {
    if (job.status !== 'completed') return
    const result = await restoreJob(job)
    if (result) onOpenResult(result)
  }

  return <section className="dashboard admin-dashboard" aria-label="Guitarica administration">
    <header className="dashboard-heading"><div><span>Operations</span><h1>Guitarica admin</h1></div><button type="button" className="text-command" onClick={onBack}>Back to account</button></header>
    <div className="dashboard-layout">
      <nav className="dashboard-nav">{(['operations', 'jobs', 'users', 'workers', ...(VOLUNTEER_FEATURE_ENABLED ? ['volunteers' as const] : []), 'audit'] as Section[]).map((item) => <button key={item} type="button" className={section === item ? 'active' : ''} onClick={() => setSection(item)}>{item}</button>)}</nav>
      <div className="dashboard-content">
        {error && <p className="form-error">{error}</p>}
        {section === 'operations' && <>
          <div className="dashboard-stats"><Metric label="Queued" value={counts.queued || 0} /><Metric label="Processing" value={counts.processing || 0} /><Metric label="Completed" value={counts.completed || 0} /><Metric label="Failed" value={counts.failed || 0} /></div>
          <Heading title="Platform kill switch" aside="" />
          <Toggle
            id="community-processing-toggle"
            checked={communityProcessingEnabled}
            onChange={toggleCommunityProcessing}
            label="Allow community hardware processing"
            description="Global switch. Off disables every community worker instantly, regardless of individual device approval status. Stays off until the packaged/encrypted worker distribution (see docs/architecture/PLATFORM_ARCHITECTURE.md) exists."
          />
          <Heading title="Worker health" aside={`${workers.length} registered`} />
          <WorkerRows workers={workers} />
        </>}
        {section === 'jobs' && <><Heading title="All jobs" aside={`${jobs.length} loaded`} /><div className="admin-table jobs-table">{jobs.map((job) => <div key={job.id}><button type="button" className="admin-job-main" disabled={job.status !== 'completed'} onClick={() => { void openJob(job) }}><span className={`job-status status-${job.status}`}>{job.status}</span><span><strong>{job.source_name}</strong><small>{profileById[job.user_id]?.email || job.user_id}</small></span><span>{job.metadata?.duration ? formatDuration(Number(job.metadata.duration)) : `${job.progress}%`}</span><span>{job.output_metrics?.detected_notes ? `${job.output_metrics.detected_notes} notes` : '-'}</span><span>{confidence(job)}</span><time>{new Date(job.created_at).toLocaleString()}</time></button>{['failed', 'cancelled'].includes(job.status) ? <button type="button" className="row-action" onClick={async () => { await retryJobAsAdmin(job.id); await refresh() }}>Retry</button> : <span />}</div>)}</div></>}
        {section === 'users' && <>
          <div className="dashboard-stats">
            <Metric label="Total users" value={userKpis?.totalUsers ?? 0} />
            <Metric label="New (7d)" value={userKpis?.newUsers7d ?? 0} />
            <Metric label="Active (7d)" value={userKpis?.activeUsers7d ?? 0} />
            <Metric label="Success rate" value={userKpis?.successRatePct != null ? `${userKpis.successRatePct}%` : '–'} />
          </div>
          <div className="dashboard-stats">
            <Metric label="Total jobs" value={userKpis?.totalJobs ?? 0} />
            <Metric label="Uploads" value={userKpis?.uploadJobs ?? 0} />
            <Metric label="YouTube" value={userKpis?.youtubeJobs ?? 0} />
            <Metric label="Avg. processing" value={userKpis?.avgProcessingSeconds != null ? formatDuration(userKpis.avgProcessingSeconds) : '–'} />
          </div>
          <Heading title="Users" aside={`${profiles.length} accounts`} />
          <div className="admin-table users-table">
            {profiles.map((profile) => <div key={profile.user_id}>
              <strong>{profile.display_name || profile.email.split('@')[0]}</strong>
              <span>{profile.email}</span>
              <span>{profile.job_count} job{profile.job_count === 1 ? '' : 's'}{profile.failed_count ? ` · ${profile.failed_count} failed` : ''}</span>
              <span>Joined {new Date(profile.created_at).toLocaleDateString()}</span>
              <time>{profile.last_job_at ? `Last job ${new Date(profile.last_job_at).toLocaleString()}` : 'No jobs yet'}</time>
            </div>)}
            {!profiles.length && <p className="dashboard-muted">No users yet.</p>}
          </div>
        </>}
        {section === 'workers' && <><Heading title="Workers" aside="Private diagnostics" /><WorkerRows workers={workers} /></>}
        {section === 'volunteers' && <>
          <Heading title="Volunteer devices" aside={`${volunteers.length} registered`} />
          <div className="admin-table volunteer-table">
            {volunteers.map((worker) => <div key={worker.worker_id}>
              <span className={`job-status status-${worker.status === 'active' ? 'completed' : worker.status === 'pending' ? 'queued' : 'failed'}`}>{worker.status}</span>
              <span><strong>{worker.label}</strong><small>{worker.worker_id} / owner {worker.owner_user_id.slice(0, 8)}</small></span>
              <span>{worker.jobs_completed} ok / {worker.jobs_failed} failed</span>
              <time>{worker.last_seen_ip || 'No IP seen yet'}</time>
              <span className="volunteer-actions">
                {worker.status !== 'active' && <button type="button" className="row-action" onClick={() => setVolunteerStatus(worker.worker_id, 'active')}>Approve</button>}
                {worker.status === 'active' && <button type="button" className="row-action" onClick={() => setVolunteerStatus(worker.worker_id, 'suspended')}>Suspend</button>}
                {worker.status !== 'revoked' && <button type="button" className="row-action danger" onClick={() => setVolunteerStatus(worker.worker_id, 'revoked')}>Revoke</button>}
              </span>
            </div>)}
            {!volunteers.length && <p className="dashboard-muted">No volunteer devices registered.</p>}
          </div>

          <Heading title="Block an identity" aside="IP, device fingerprint, or user" />
          <div className="block-form">
            <select value={blockKind} onChange={(event) => setBlockKind(event.target.value as typeof blockKind)}>
              <option value="ip">IP address</option>
              <option value="device_fingerprint">Device fingerprint</option>
              <option value="user">User ID</option>
            </select>
            <input type="text" placeholder="Value to block" value={blockValue} onChange={(event) => setBlockValue(event.target.value)} />
            <input type="text" placeholder="Reason (optional)" value={blockReason} onChange={(event) => setBlockReason(event.target.value)} />
            <button type="button" className="row-action danger" onClick={submitBlock}>Block</button>
          </div>
        </>}
        {section === 'audit' && <>
          <Heading title="Audit log" aside={`${auditLog.length} recent entries`} />
          <div className="admin-table audit-table">
            {auditLog.map((entry) => (
              <div key={entry.id}>
                <span><strong>{entry.action}</strong><small>{entry.target_type}{entry.target_id ? ` / ${entry.target_id}` : ''}</small></span>
                <span>{entry.actor_user_id ? profileById[entry.actor_user_id]?.email || entry.actor_user_id.slice(0, 8) : 'system'}</span>
                <time>{new Date(entry.created_at).toLocaleString()}</time>
              </div>
            ))}
            {!auditLog.length && <p className="dashboard-muted">No audit entries yet.</p>}
          </div>
        </>}
      </div>
    </div>
  </section>
}

function WorkerRows({ workers }: { workers: AdminWorkerRow[] }) {
  return <div className="worker-list">{workers.map((worker) => <article key={worker.worker_id}>
    <span className={`worker-dot ${worker.status}`} />
    <div><strong>{worker.label}</strong><small>{worker.trust_tier} / {worker.gpu_name || 'GPU unknown'} / {worker.model_version || 'model unknown'}</small></div>
    <span>{worker.status}</span>
    <span>{worker.jobs_completed} completed</span>
    <time>{worker.last_heartbeat_at ? new Date(worker.last_heartbeat_at).toLocaleString() : 'Never online'}</time>
  </article>)}{!workers.length && <p className="dashboard-muted">No worker has checked in yet.</p>}</div>
}
function Metric({ label, value }: { label: string; value: number | string }) { return <div><span>{label}</span><strong>{value}</strong></div> }
function Heading({ title, aside }: { title: string; aside: string }) { return <div className="dashboard-section-heading"><h2>{title}</h2><span>{aside}</span></div> }
function confidence(job: GuitaricaJob) { const value = Number(job.output_metrics?.mean_confidence); return Number.isFinite(value) ? `${Math.round(value * 100)}% confidence` : 'Not measured' }
