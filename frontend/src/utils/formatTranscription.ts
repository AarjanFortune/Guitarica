import { ModelVariant, TranscribedNote } from '../types/transcription'

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function mapBackendNotes(payload: any): TranscribedNote[] {
  const rawNotes = payload?.pianoroll?.notes
  if (!Array.isArray(rawNotes)) return []

  return rawNotes
    .map((note: any) => ({
      time: Number(note.start_time),
      stringIdx: 5 - Number(note.string),
      fret: Number(note.fret),
      duration: Number(note.duration) || 0.18,
      midi: Number.isFinite(Number(note.midi)) ? Number(note.midi) : undefined,
    }))
    .filter((note: TranscribedNote) => (
      Number.isFinite(note.time) &&
      Number.isFinite(note.stringIdx) &&
      Number.isFinite(note.fret) &&
      note.stringIdx >= 0 &&
      note.stringIdx <= 5 &&
      note.fret >= 0
    ))
    .sort((a: TranscribedNote, b: TranscribedNote) => a.time - b.time)
}

// mapBackendNotes reads payload.pianoroll.notes generically, so it applies
// unchanged to each individual model variant too (each has its own
// pianoroll in the same shape as the top-level response).
export function mapModelVariants(payload: any): ModelVariant[] | undefined {
  const rawVariants = payload?.models
  if (!Array.isArray(rawVariants) || !rawVariants.length) return undefined

  return rawVariants.map((variant: any) => ({
    id: String(variant?.id ?? ''),
    label: String(variant?.label ?? variant?.id ?? 'Model'),
    notes: mapBackendNotes(variant),
    confidence: Array.isArray(variant?.confidence) ? variant.confidence : [],
    outputMetrics: variant?.output_metrics,
  }))
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid duration from backend.')
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainingSeconds}`
}

export function formatTempo(tempo: number): string {
  if (!Number.isFinite(tempo)) throw new Error('Invalid tempo from backend.')
  return `${Math.round(tempo)} BPM`
}

// Supabase's PostgrestError (and some other thrown values) are typed as
// Error but aren't always real Error instances at runtime, so `instanceof
// Error` can silently miss the real message and fall through to a useless
// generic string. Pull `.message` off anything that has one first.
export function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    const message = (err as { message: string }).message
    return message || fallback
  }
  return fallback
}

// For a Promise.allSettled panel load: label the rejected entries without
// letting one broken RPC blank the sections that succeeded. Returns null
// for a fulfilled result so callers can filter it straight out.
export function describeSettledFailure(label: string, result: PromiseSettledResult<unknown>): string | null {
  if (result.status !== 'rejected') return null
  return `${label}: ${errorMessage(result.reason, String(result.reason))}`
}
