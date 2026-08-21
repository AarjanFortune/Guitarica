export type SourceType = 'upload' | 'youtube' | 'live'
export type FeatureType = 'cqt' | 'mel'

export interface TranscribedNote {
  stringIdx: number
  fret: number
  time: number
  duration: number
  midi?: number
}

export interface BackendMetadata {
  duration: number
  sample_rate: number
  n_frames: number
  tempo: number
  feature_type: string
  model?: string
  note_resolution?: number
}

export interface BackendSourceMetadata {
  kind: 'upload' | 'youtube'
  name: string
  size_bytes: number
  url?: string | null
}

export interface BackendOutputMetrics {
  model?: string
  bpm_used?: number
  note_steps?: number
  detected_notes?: number
  active_frame_ratio?: number
  mean_confidence?: number
  onset_count?: number
  mean_onset_confidence?: number
  ensemble_size?: number
}

export interface BackendModelVariant {
  id: string
  label: string
  pianoroll?: {
    notes?: unknown[]
    total_duration?: number
  }
  confidence?: number[][]
  output_metrics?: BackendOutputMetrics
}

export interface BackendTranscriptionResponse {
  status: 'success'
  source: BackendSourceMetadata
  tab?: unknown[]
  pitch?: unknown[]
  confidence?: number[][]
  pianoroll?: {
    notes?: unknown[]
    total_duration?: number
  }
  metadata: BackendMetadata
  artifacts?: {
    session_id?: string
    midi_url?: string
    npz_url?: string
    visualization_url?: string
    bucket?: string
    midi_path?: string
    npz_path?: string
    visualization_path?: string
  }
  output_metrics?: BackendOutputMetrics
  // Present only when the worker ran a fold ensemble: one entry per
  // individual model plus one "majority" (soft-voted) entry, each with its
  // own predicted notes -- lets the UI show what any single model alone
  // would have produced, not just the combined result. See
  // model_runtime/final_pipeline.py's format_final_response.
  models?: BackendModelVariant[]
  audio_url?: string | null
}

// One selectable entry in the report's model dropdown -- either the
// combined "majority" result or one individual fold, already mapped to the
// same TranscribedNote[] shape the report renders everywhere else.
export interface ModelVariant {
  id: string
  label: string
  notes: TranscribedNote[]
  confidence: number[][]
  outputMetrics?: BackendOutputMetrics
}

export interface TranscriptionResult {
  notes: TranscribedNote[]
  metadata: BackendMetadata
  source: BackendSourceMetadata
  audioUrl?: string | null
  // The actual audio bytes, if this browser has them in memory this
  // session -- a picked upload File, or a fetched Blob for YouTube. Not
  // necessarily saved anywhere yet; see jobId + services/audioCache.ts.
  sourceFile?: Blob | null
  jobId?: string | null
  confidence?: number[][]
  artifacts?: BackendTranscriptionResponse['artifacts']
  outputMetrics?: BackendOutputMetrics
  // Only set when the job ran a fold ensemble. `notes`/`confidence`/
  // `outputMetrics` above always mirror the "majority" entry in this list,
  // so code that ignores this field keeps working exactly as before.
  models?: ModelVariant[]
}
