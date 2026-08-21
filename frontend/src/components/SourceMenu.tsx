import { SourceType } from '../types/transcription'
import { VisualConfig, visualStyle } from '../visualConfig'

interface SourceMenuProps {
  onSelect: (source: SourceType) => void
  onGuitarClick: () => void
  visualConfig: VisualConfig
}

const SOURCES: Array<{ id: SourceType; label: string; detail: string; icon: SourceType }> = [
  { id: 'upload', label: 'Audio file', detail: 'Upload', icon: 'upload' },
  { id: 'youtube', label: 'YouTube', detail: 'Paste link', icon: 'youtube' },
  { id: 'live', label: 'Live input', detail: 'Listen', icon: 'live' },
]

export default function SourceMenu({ onSelect, onGuitarClick, visualConfig }: SourceMenuProps) {
  return (
    <section className="source-menu" aria-labelledby="source-menu-title">
      <div className="menu-copy" style={visualStyle(visualConfig.menuContent)}>
        <p>Transcription studio</p>
        <h1 id="source-menu-title">Choose source</h1>

        <nav className="menu-options" aria-label="Choose audio source">
          {SOURCES.map((source, index) => (
            <button key={source.id} type="button" onClick={() => onSelect(source.id)}>
              <span className="menu-number">0{index + 1}</span>
              <span className="menu-label">{source.label}</span>
              <span className="menu-icon" aria-hidden="true">
                <SourceIcon type={source.icon} />
              </span>
              <span className="menu-detail">{source.detail}</span>
            </button>
          ))}
        </nav>
      </div>

      <button
        type="button"
        className="instrument-stage"
        style={visualStyle(visualConfig.menuGuitar)}
        onClick={onGuitarClick}
        aria-label="Play Guitarica sound"
      >
        <img src="/images/Guitarica.png" alt="" />
      </button>
    </section>
  )
}

function SourceIcon({ type }: { type: SourceType }) {
  if (type === 'upload') {
    return (
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M7.2 16.8H6.7a4.2 4.2 0 0 1-.5-8.3 5.7 5.7 0 0 1 10.9 1.5h.3a3.4 3.4 0 0 1 0 6.8h-.7" />
        <path d="M12 17V10" />
        <path d="m9.1 12.9 2.9-2.9 2.9 2.9" />
      </svg>
    )
  }

  if (type === 'youtube') {
    return (
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M8.7 6.7 17 12l-8.3 5.3V6.7Z" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M12 14.2a2.8 2.8 0 0 0 2.8-2.8V6.7a2.8 2.8 0 0 0-5.6 0v4.7a2.8 2.8 0 0 0 2.8 2.8Z" />
      <path d="M7 11.5a5 5 0 0 0 10 0" />
      <path d="M12 16.6v3.2" />
      <path d="M9.4 19.8h5.2" />
    </svg>
  )
}
