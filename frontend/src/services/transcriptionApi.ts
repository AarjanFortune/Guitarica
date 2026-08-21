import { BackendTranscriptionResponse } from '../types/transcription'

const API_BASE = ''

export interface YouTubeMetadata {
  title: string
  video_id: string
  webpage_url: string
  duration: number | null
}

async function parseResponse(response: Response): Promise<BackendTranscriptionResponse> {
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const message = payload?.detail || payload?.error || `Request failed with status ${response.status}`
    throw new Error(message)
  }

  if (payload?.status === 'error') {
    throw new Error(payload.error || 'Transcription failed')
  }

  if (payload?.status !== 'success' || !payload.source || !payload.metadata || !Array.isArray(payload?.pianoroll?.notes)) {
    throw new Error('Backend returned an incomplete transcription result.')
  }

  return payload as BackendTranscriptionResponse
}

export async function transcribeUpload(file: File) {
  const formData = new FormData()
  formData.append('audio', file)

  const response = await fetch(`${API_BASE}/transcribe`, {
    method: 'POST',
    body: formData,
  })

  return parseResponse(response)
}

export async function transcribeYoutube(url: string) {
  const response = await fetch(`${API_BASE}/transcribe_youtube`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })

  return parseResponse(response)
}

export async function fetchYoutubeMetadata(url: string): Promise<YouTubeMetadata> {
  const response = await fetch(`${API_BASE}/youtube_metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const message = payload?.detail || payload?.error || `Request failed with status ${response.status}`
    throw new Error(message)
  }

  return {
    title: typeof payload?.title === 'string' ? payload.title : 'YouTube video',
    video_id: typeof payload?.video_id === 'string' ? payload.video_id : '',
    webpage_url: typeof payload?.webpage_url === 'string' ? payload.webpage_url : url,
    duration: typeof payload?.duration === 'number' ? payload.duration : null,
  }
}
