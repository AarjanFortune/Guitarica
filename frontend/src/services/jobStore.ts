import { Session } from '@supabase/supabase-js'
import { getLocalAudio } from './audioCache'
import { BackendTranscriptionResponse, TranscriptionResult } from '../types/transcription'
import { mapBackendNotes, mapModelVariants } from '../utils/formatTranscription'
import { supabase } from './supabaseClient'

export type JobStatus = 'queued' | 'retrying' | 'processing' | 'completed' | 'failed' | 'cancelled'

export interface GuitaricaJob {
  id: string
  user_id: string
  source_kind: 'upload' | 'youtube'
  source_name: string
  source_url: string | null
  source_size_bytes: number | null
  source_audio_bucket: string | null
  source_audio_path: string | null
  status: JobStatus
  progress: number
  attempts: number
  estimated_processing_seconds: number | null
  queued_at: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  metadata: Record<string, unknown> | null
  output_metrics: Record<string, unknown> | null
  artifacts: Record<string, string> | null
  result_payload: BackendTranscriptionResponse | null
  model_version: string | null
  created_at: string
}

export interface GuitaricaNotification {
  id: string
  job_id: string | null
  kind: string
  title: string
  body: string | null
  read_at: string | null
  created_at: string
}

export interface QueueStatus {
  worker_state: 'online' | 'busy' | 'offline'
  worker_last_seen_at: string | null
  queued_jobs: number
  queue_position: number
  estimated_wait_seconds: number | null
}

const JOB_COLUMNS = 'id,user_id,source_kind,source_name,source_url,source_size_bytes,source_audio_bucket,source_audio_path,status,progress,attempts,estimated_processing_seconds,queued_at,started_at,completed_at,error_message,metadata,output_metrics,artifacts,result_payload,model_version,created_at'

function requireSupabase() {
  if (!supabase) throw new Error('Supabase is not configured.')
  return supabase
}

export async function initializeGuitaricaAccount() {
  const client = requireSupabase()
  const { error } = await client.rpc('ensure_guitarica_profile')
  if (error) throw error
}

export async function listJobs(limit = 100): Promise<GuitaricaJob[]> {
  const { data, error } = await requireSupabase()
    .from('guitarica_jobs')
    .select(JOB_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data || []) as GuitaricaJob[]
}

export async function getJobById(id: string): Promise<GuitaricaJob | null> {
  const { data, error } = await requireSupabase()
    .from('guitarica_jobs')
    .select(JOB_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return (data as GuitaricaJob) || null
}

export async function listNotifications(): Promise<GuitaricaNotification[]> {
  const { data, error } = await requireSupabase()
    .from('guitarica_notifications')
    .select('id,job_id,kind,title,body,read_at,created_at')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data || []) as GuitaricaNotification[]
}

export async function listRoles(): Promise<string[]> {
  const { data, error } = await requireSupabase().from('guitarica_user_roles').select('role')
  if (error) throw error
  return (data || []).map((row) => row.role)
}

export async function getQueueStatus(jobId?: string): Promise<QueueStatus | null> {
  const { data, error } = await requireSupabase().rpc('get_guitarica_queue_status', { p_job_id: jobId || null })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return row ? row as QueueStatus : null
}

export async function markNotificationRead(id: string) {
  const { error } = await requireSupabase()
    .from('guitarica_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function cancelJob(id: string) {
  const { error } = await requireSupabase().rpc('cancel_guitarica_job', { p_job_id: id })
  if (error) throw error
}

export async function retryJobAsAdmin(id: string) {
  const { error } = await requireSupabase().rpc('admin_retry_guitarica_job', { p_job_id: id })
  if (error) throw error
}

export async function queueUpload(
  file: File,
  duration: number | null,
  session: Session,
  allowVolunteerProcessing = false,
): Promise<GuitaricaJob> {
  if (file.size > 25 * 1024 * 1024) throw new Error('Audio files are limited to 25 MB.')
  const client = requireSupabase()
  const jobId = crypto.randomUUID()
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-140) || 'audio'
  const path = `${session.user.id}/${jobId}/${safeName}`
  const { error: uploadError } = await client.storage.from('guitarica-inputs').upload(path, file, {
    contentType: file.type || 'audio/mpeg',
    upsert: false,
  })
  if (uploadError) throw uploadError

  const { data, error } = await client.rpc('submit_guitarica_job', {
    p_job_id: jobId,
    p_source_kind: 'upload',
    p_source_name: file.name,
    p_source_url: null,
    p_source_size_bytes: file.size,
    p_source_mime_type: file.type || 'audio/mpeg',
    p_input_path: path,
    p_estimated_processing_seconds: estimateSeconds(duration),
    p_allow_volunteer_processing: allowVolunteerProcessing,
  })
  if (error) {
    await client.storage.from('guitarica-inputs').remove([path])
    throw error
  }
  return (Array.isArray(data) ? data[0] : data) as GuitaricaJob
}

export async function queueYoutube(url: string, duration: number | null): Promise<GuitaricaJob> {
  const normalized = normalizeYoutubeUrl(url)
  const { data, error } = await requireSupabase().rpc('submit_guitarica_job', {
    p_job_id: crypto.randomUUID(),
    p_source_kind: 'youtube',
    p_source_name: `YouTube ${new URL(normalized).pathname.split('/').filter(Boolean).pop() || 'video'}`,
    p_source_url: normalized,
    p_source_size_bytes: null,
    p_source_mime_type: null,
    p_input_path: null,
    p_estimated_processing_seconds: estimateSeconds(duration),
  })
  if (error) throw error
  return (Array.isArray(data) ? data[0] : data) as GuitaricaJob
}

// --- Volunteer worker enrollment -------------------------------------------
// YouTube jobs are never volunteer-eligible (submit_guitarica_job enforces
// this server-side too): a volunteer's home IP would otherwise be the one
// fetching third-party video URLs.

export interface VolunteerPairing { code: string; expiresAt: string }

export interface VolunteerWorker {
  worker_id: string
  label: string
  status: 'pending' | 'active' | 'suspended' | 'revoked'
  jobs_completed: number
  jobs_failed: number
  last_seen_at: string | null
  created_at: string
}

export async function beginVolunteerPairing(): Promise<VolunteerPairing> {
  const { data, error } = await requireSupabase().rpc('begin_volunteer_pairing')
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return { code: row.code, expiresAt: row.expires_at }
}

export async function listMyVolunteerWorkers(): Promise<VolunteerWorker[]> {
  const { data, error } = await requireSupabase().rpc('list_my_volunteer_workers')
  if (error) throw error
  return (data || []) as VolunteerWorker[]
}

export async function revokeMyVolunteerWorker(workerId: string): Promise<void> {
  const { error } = await requireSupabase().rpc('revoke_my_volunteer_worker', { p_worker_id: workerId })
  if (error) throw error
}

export interface AdminVolunteerWorker extends VolunteerWorker {
  owner_user_id: string
  trust_tier: string
  device_fingerprint_hash: string
  last_seen_ip: string | null
}

export async function adminListVolunteerWorkers(): Promise<AdminVolunteerWorker[]> {
  const { data, error } = await requireSupabase()
    .from('guitarica_worker_credentials')
    .select('worker_id,owner_user_id,label,status,trust_tier,jobs_completed,jobs_failed,last_seen_ip,last_seen_at,device_fingerprint_hash,created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []) as AdminVolunteerWorker[]
}

export async function adminSetVolunteerWorkerStatus(workerId: string, status: 'active' | 'suspended' | 'revoked'): Promise<void> {
  const { error } = await requireSupabase().rpc('admin_set_volunteer_worker_status', { p_worker_id: workerId, p_status: status })
  if (error) throw error
}

export async function adminBlockIdentity(kind: 'ip' | 'device_fingerprint' | 'user', value: string, reason: string): Promise<void> {
  const { error } = await requireSupabase().rpc('admin_block_identity', { p_kind: kind, p_value: value, p_reason: reason, p_expires_at: null })
  if (error) throw error
}

export async function restoreJob(job: GuitaricaJob): Promise<TranscriptionResult | null> {
  const payload = job.result_payload
  if (!payload?.metadata || !payload.source) return null
  const artifacts = payload.artifacts || {}
  const bucket = (artifacts as Record<string, string>).bucket
  const signed: Record<string, string> = { ...(artifacts as Record<string, string>) }
  if (bucket) {
    for (const [name, path] of Object.entries(artifacts as Record<string, string>)) {
      if (!name.endsWith('_path') || !path) continue
      const { data } = await requireSupabase().storage.from(bucket).createSignedUrl(path, 900)
      if (data?.signedUrl) signed[name.replace('_path', '_url')] = data.signedUrl
    }
  }
  // The server never stores raw audio; a playable copy only exists here if
  // this browser opted in to keeping a local one when the job was
  // submitted. (When restoreJob is called right after a job completes in
  // this same session, the caller merges in whatever it already has in
  // memory -- see UploadPanel/YouTubePanel -- since that's available
  // whether or not a local copy was ever saved.)
  const cachedAudio = await getLocalAudio(job.id).catch(() => null)
  const audioUrl = cachedAudio ? URL.createObjectURL(cachedAudio) : null
  return {
    notes: mapBackendNotes(payload),
    metadata: payload.metadata,
    source: payload.source,
    audioUrl,
    sourceFile: cachedAudio,
    jobId: job.id,
    confidence: payload.confidence || [],
    artifacts: signed,
    outputMetrics: payload.output_metrics,
    models: mapModelVariants(payload),
  }
}

// The worker publishes the real extracted YouTube audio to storage while
// transcription is still running, so this can be called as soon as a
// queued job's source_audio_path shows up -- no need to wait for the job
// to complete. Storage here is a one-time relay, not persisted audio
// storage: this pulls the actual bytes into memory (not just a link) so
// they survive for the rest of this session either way, and then tells the
// worker it's safe to reclaim its copy -- audio storage from here on is
// entirely the browser's decision (see services/audioCache.ts).
export async function fetchSourceAudio(job: GuitaricaJob): Promise<Blob | null> {
  if (!job.source_audio_bucket || !job.source_audio_path) return null
  const { data, error } = await requireSupabase()
    .storage
    .from(job.source_audio_bucket)
    .createSignedUrl(job.source_audio_path, 600)
  if (error) throw error
  if (!data?.signedUrl) return null

  const response = await fetch(data.signedUrl)
  if (!response.ok) throw new Error('Could not download the extracted audio.')
  const blob = await response.blob()

  // Best-effort: if this fails, the job's normal input-retention window
  // still reclaims the relay object later, it just won't be as quick.
  try {
    await requireSupabase().rpc('mark_guitarica_source_audio_consumed', { p_job_id: job.id })
  } catch {
    // ignored -- see comment above
  }
  return blob
}

export function subscribeToAccount(userId: string, refresh: () => void) {
  const client = requireSupabase()
  // App.tsx and AccountDashboard.tsx both call this for the same user at the
  // same time. Supabase's realtime client reuses an existing channel object
  // for an identical topic string, so a shared topic here means the second
  // caller's .on() lands on a channel the first caller already .subscribe()'d
  // -- which throws and crashes the whole app (no error boundary catches it).
  // A random suffix guarantees every call gets its own channel object.
  const topic = `guitarica-account-${userId}-${Math.random().toString(36).slice(2)}`
  const channel = client
    .channel(topic)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'guitarica_jobs', filter: `user_id=eq.${userId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'guitarica_notifications', filter: `user_id=eq.${userId}` }, refresh)
    .subscribe()
  return () => { void client.removeChannel(channel) }
}

// --- Platform settings (Phase 1 global kill switch) -------------------------

export async function getPlatformSettings(): Promise<{ communityProcessingEnabled: boolean }> {
  const { data, error } = await requireSupabase().rpc('get_platform_settings')
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return { communityProcessingEnabled: Boolean(row?.community_processing_enabled) }
}

export interface AdminPlatformSettings {
  communityProcessingEnabled: boolean
  updatedBy: string | null
  updatedAt: string | null
}

export async function adminGetPlatformSettings(): Promise<AdminPlatformSettings> {
  const { data, error } = await requireSupabase().rpc('admin_get_platform_settings')
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return {
    communityProcessingEnabled: Boolean(row?.community_processing_enabled),
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

export async function adminSetPlatformSettings(communityProcessingEnabled: boolean): Promise<void> {
  const { error } = await requireSupabase().rpc('admin_set_platform_settings', {
    p_community_processing_enabled: communityProcessingEnabled,
  })
  if (error) throw error
}

// --- Admin worker + audit views ---------------------------------------------

export interface AdminWorkerRow {
  worker_id: string
  label: string
  trust_tier: 'trusted' | 'volunteer'
  status: string
  gpu_name: string | null
  model_version: string | null
  jobs_completed: number
  jobs_failed: number
  owner_user_id: string | null
  last_heartbeat_at: string | null
  created_at: string | null
}

export async function adminListWorkers(): Promise<AdminWorkerRow[]> {
  const { data, error } = await requireSupabase().rpc('admin_list_workers')
  if (error) throw error
  return (data || []) as AdminWorkerRow[]
}

export interface AuditLogEntry {
  id: number
  actor_user_id: string | null
  action: string
  target_type: string
  target_id: string | null
  details: Record<string, unknown>
  created_at: string
}

export async function adminListAuditLog(limit = 100): Promise<AuditLogEntry[]> {
  const { data, error } = await requireSupabase().rpc('admin_list_audit_log', { p_limit: limit })
  if (error) throw error
  return (data || []) as AuditLogEntry[]
}

export interface AdminUserKpis {
  totalUsers: number
  newUsers7d: number
  newUsers30d: number
  activeUsers7d: number
  totalJobs: number
  jobsCompleted: number
  jobsFailed: number
  successRatePct: number | null
  avgProcessingSeconds: number | null
  uploadJobs: number
  youtubeJobs: number
}

export async function adminGetUserKpis(): Promise<AdminUserKpis> {
  const { data, error } = await requireSupabase().rpc('admin_get_user_kpis')
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return {
    totalUsers: Number(row?.total_users || 0),
    newUsers7d: Number(row?.new_users_7d || 0),
    newUsers30d: Number(row?.new_users_30d || 0),
    activeUsers7d: Number(row?.active_users_7d || 0),
    totalJobs: Number(row?.total_jobs || 0),
    jobsCompleted: Number(row?.jobs_completed || 0),
    jobsFailed: Number(row?.jobs_failed || 0),
    successRatePct: row?.success_rate_pct === null || row?.success_rate_pct === undefined ? null : Number(row.success_rate_pct),
    avgProcessingSeconds: row?.avg_processing_seconds === null || row?.avg_processing_seconds === undefined ? null : Number(row.avg_processing_seconds),
    uploadJobs: Number(row?.upload_jobs || 0),
    youtubeJobs: Number(row?.youtube_jobs || 0),
  }
}

export interface AdminUserActivityRow {
  user_id: string
  email: string
  display_name: string | null
  created_at: string
  last_seen_at: string
  job_count: number
  completed_count: number
  failed_count: number
  last_job_at: string | null
}

export async function adminListUsersWithActivity(limit = 200): Promise<AdminUserActivityRow[]> {
  const { data, error } = await requireSupabase().rpc('admin_list_users_with_activity', { p_limit: limit })
  if (error) throw error
  return (data || []) as AdminUserActivityRow[]
}

export async function expireMyJobNow(jobId: string): Promise<void> {
  const { error } = await requireSupabase().rpc('expire_my_job_now', { p_job_id: jobId })
  if (error) throw error
}

function estimateSeconds(duration: number | null): number {
  return Math.max(45, Math.round((duration || 60) * 2.55 + 72))
}

function normalizeYoutubeUrl(raw: string): string {
  const value = raw.trim()
  const parsed = new URL(value.includes('://') ? value : `https://${value}`)
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Enter a valid YouTube URL.')
  }
  parsed.protocol = 'https:'
  return parsed.toString()
}
