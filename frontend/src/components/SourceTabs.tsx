import { SourceType } from '../types/transcription'

interface SourceTabsProps {
  activeSource: SourceType
  onChange: (source: SourceType) => void
}

const SOURCES: Array<{ id: SourceType; label: string }> = [
  { id: 'upload', label: 'File' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'live', label: 'Live' },
]

export default function SourceTabs({ activeSource, onChange }: SourceTabsProps) {
  return (
    <nav className="source-tabs" aria-label="Transcription source">
      {SOURCES.map((source) => (
        <button
          key={source.id}
          type="button"
          className={activeSource === source.id ? 'source-tab source-tab-active' : 'source-tab'}
          onClick={() => onChange(source.id)}
        >
          {source.label}
        </button>
      ))}
    </nav>
  )
}
