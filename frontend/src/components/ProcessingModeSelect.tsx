import RadioCard, { RadioGroup } from '../ui/RadioCard'

export type ProcessingMode = 'guitarica' | 'local' | 'community'

interface Props {
  mode: ProcessingMode
  onChange: (mode: ProcessingMode) => void
  communityAvailable: boolean
}

// Only "guitarica" is functional today. The other two are shown, not
// hidden -- the information architecture is real and forward-compatible --
// but honestly labeled unavailable rather than silently failing if clicked.
export default function ProcessingModeSelect({ mode, onChange, communityAvailable }: Props) {
  return (
    <RadioGroup label="Processing location">
      <RadioCard
        selected={mode === 'guitarica'}
        onSelect={() => onChange('guitarica')}
        title="Use Guitarica processing"
        description="Runs on our GPU. If it's busy you'll see your position in the queue and an estimated wait."
      />
      <RadioCard
        selected={false}
        onSelect={() => undefined}
        disabled
        title="Process on this device"
        description="Runs entirely in your browser -- nothing uploaded. Needs in-browser inference support that isn't built yet."
        badge="Coming soon"
      />
      <RadioCard
        selected={mode === 'community'}
        onSelect={() => onChange('community')}
        disabled={!communityAvailable}
        title="Use community hardware"
        description="Runs on another user's device once they've opted in, only when ours is busy."
        badge={communityAvailable ? undefined : 'Coming soon'}
      />
    </RadioGroup>
  )
}
