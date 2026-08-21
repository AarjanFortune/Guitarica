import RadioCard, { RadioGroup } from '../ui/RadioCard'

export type SessionStorageMode = 'cloud' | 'ephemeral'

interface Props {
  mode: SessionStorageMode
  onChange: (mode: SessionStorageMode) => void
}

export default function SessionStoragePreference({ mode, onChange }: Props) {
  return (
    <RadioGroup label="Session storage">
      <RadioCard
        selected={mode === 'cloud'}
        onSelect={() => onChange('cloud')}
        title="Keep in my account"
        description="Saved to your account and visible across devices. You can delete it anytime from Transcriptions."
      />
      <RadioCard
        selected={mode === 'ephemeral'}
        onSelect={() => onChange('ephemeral')}
        title="Keep on this device only"
        description="Still processed by Guitarica's queue, but removed from our servers within the hour and not visible on other devices. Automatically keeps the audio and the transcription locally so you can still open it here -- and sync it to your account later from Transcriptions if you change your mind."
      />
    </RadioGroup>
  )
}
