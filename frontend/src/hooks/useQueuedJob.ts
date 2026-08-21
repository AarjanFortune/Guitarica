import { useEffect, useState } from 'react'
import { getJobById, getQueueStatus, GuitaricaJob, QueueStatus } from '../services/jobStore'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/** Polls a single queued job until it reaches a terminal state, so the
 * caller can stay on the same screen instead of navigating away. */
export default function useQueuedJob(jobId: string | null) {
  const [job, setJob] = useState<GuitaricaJob | null>(null)
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null)

  useEffect(() => {
    if (!jobId) { setJob(null); setQueueStatus(null); return undefined }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const [nextJob, nextQueue] = await Promise.all([getJobById(jobId), getQueueStatus(jobId)])
        if (cancelled) return
        setJob(nextJob)
        setQueueStatus(nextQueue)
        if (nextJob && TERMINAL_STATUSES.has(nextJob.status)) return
      } catch {
        // transient network hiccup -- keep polling
      }
      if (!cancelled) timer = setTimeout(poll, 3000)
    }

    void poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [jobId])

  return { job, queueStatus }
}
