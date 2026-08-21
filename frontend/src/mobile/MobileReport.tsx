import { TranscriptionResult } from '../types/transcription'
import { formatDuration, formatTempo } from '../utils/formatTranscription'

interface Props {
  result: TranscriptionResult
  onReset: () => void
}

export default function MobileReport({ result, onReset }: Props) {
  const artifacts = [
    result.artifacts?.visualization_url ? { label: 'Sheet image', href: result.artifacts.visualization_url } : null,
    result.artifacts?.midi_url ? { label: 'MIDI file', href: result.artifacts.midi_url } : null,
    result.artifacts?.npz_url ? { label: 'NPZ archive', href: result.artifacts.npz_url } : null,
  ].filter((item): item is { label: string; href: string } => item !== null)

  return (
    <div>
      <p className="m-eyebrow">{result.source.kind === 'youtube' ? 'YouTube' : 'Audio file'}</p>
      <h1 className="m-title">{result.source.name}</h1>

      <div className="m-stat-grid">
        <div className="m-stat"><span>Duration</span><strong>{formatDuration(result.metadata.duration)}</strong></div>
        <div className="m-stat"><span>Tempo</span><strong>{formatTempo(result.metadata.tempo)}</strong></div>
        <div className="m-stat"><span>Notes</span><strong>{result.notes.length}</strong></div>
        <div className="m-stat"><span>Feature set</span><strong>{result.metadata.feature_type.toUpperCase()}</strong></div>
      </div>

      {result.artifacts?.visualization_url && (
        <div className="m-preview">
          <img src={result.artifacts.visualization_url} alt="Tab visualization" />
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="m-artifact-list">
          {artifacts.map((artifact) => (
            <a key={artifact.label} href={artifact.href} target="_blank" rel="noreferrer">
              <span>{artifact.label}</span><span aria-hidden="true">↓</span>
            </a>
          ))}
        </div>
      )}

      <button type="button" className="m-button secondary" style={{ marginTop: 18 }} onClick={onReset}>
        New transcription
      </button>
    </div>
  )
}
