import { useState } from 'react'
import Toggle from '../ui/Toggle'
import ProcessingModeSelect, { ProcessingMode } from './ProcessingModeSelect'
import SessionStoragePreference, { SessionStorageMode } from './SessionStoragePreference'

const MODE_LABEL: Record<ProcessingMode, string> = {
  guitarica: 'Guitarica processing',
  local: 'This device',
  community: 'Community hardware',
}
const STORAGE_LABEL: Record<SessionStorageMode, string> = {
  cloud: 'Keep in my account',
  ephemeral: 'Keep on this device only',
}

interface Props {
  showProcessingMode?: boolean
  mode: ProcessingMode
  onModeChange: (mode: ProcessingMode) => void
  communityAvailable: boolean
  storageMode: SessionStorageMode
  onStorageModeChange: (mode: SessionStorageMode) => void
  keepAudioLocally?: boolean
  onKeepAudioLocallyChange?: (value: boolean) => void
  keepDataLocally?: boolean
  onKeepDataLocallyChange?: (value: boolean) => void
}

// Collapsed by default -- one line, one "Change" action. Only the person
// who wants something other than the default ever sees the full choice.
export default function ProcessingOptions({
  showProcessingMode = true,
  mode,
  onModeChange,
  communityAvailable,
  storageMode,
  onStorageModeChange,
  keepAudioLocally,
  onKeepAudioLocallyChange,
  keepDataLocally,
  onKeepDataLocallyChange,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const summary = showProcessingMode ? `${MODE_LABEL[mode]} · ${STORAGE_LABEL[storageMode]}` : STORAGE_LABEL[storageMode]

  return (
    <div className="gt-disclosure">
      <button type="button" className="gt-disclosure-trigger" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span>{summary}</span>
        <span className="gt-disclosure-action">{expanded ? 'Done' : 'Change'}</span>
      </button>
      {expanded && (
        <div className="gt-disclosure-body">
          {showProcessingMode && (
            <ProcessingModeSelect mode={mode} onChange={onModeChange} communityAvailable={communityAvailable} />
          )}
          <SessionStoragePreference mode={storageMode} onChange={onStorageModeChange} />
          {/* "Keep on this device only" already saves both of these automatically
              (see SessionStoragePreference's copy) -- these toggles are only the
              opt-in add-ons for people who kept the "in my account" default. */}
          {storageMode === 'cloud' && onKeepAudioLocallyChange && (
            <Toggle
              id="keep-audio-locally"
              checked={Boolean(keepAudioLocally)}
              onChange={onKeepAudioLocallyChange}
              label="Store audio locally"
              description="Lets you play the original audio back from Transcriptions even if you're offline."
            />
          )}
          {storageMode === 'cloud' && onKeepDataLocallyChange && (
            <Toggle
              id="keep-data-locally"
              checked={Boolean(keepDataLocally)}
              onChange={onKeepDataLocallyChange}
              label="Store the rest of the transcription data locally too"
              description="Notes and tab stay openable from this device even if you later delete it from your account."
            />
          )}
        </div>
      )}
    </div>
  )
}
