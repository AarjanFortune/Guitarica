const OBSERVED_PROCESSING_RATIO = 240 / 156
const DEFAULT_YOUTUBE_ESTIMATE_SECONDS = 240

export function estimateProcessingSeconds(audioDurationSeconds?: number | null): number {
  if (!audioDurationSeconds || !Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) {
    return DEFAULT_YOUTUBE_ESTIMATE_SECONDS
  }

  return Math.max(60, Math.ceil(audioDurationSeconds * OBSERVED_PROCESSING_RATIO))
}

