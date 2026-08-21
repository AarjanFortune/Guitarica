import { ReactNode } from 'react'

interface RadioCardProps {
  selected: boolean
  onSelect: () => void
  title: string
  description: string
  badge?: string
  disabled?: boolean
}

// One option in a single-select group -- a flat, hairline-divided row with
// a custom dot marker, matching the app's existing visual language. Not a
// bordered/shadowed "card" and not a native <input type="radio">.
export default function RadioCard({ selected, onSelect, title, description, badge, disabled }: RadioCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      className={[
        'gt-radio-card',
        selected ? 'gt-radio-card-selected' : '',
        disabled ? 'gt-radio-card-disabled' : '',
      ].filter(Boolean).join(' ')}
      onClick={onSelect}
    >
      <span className="gt-radio-card-marker" aria-hidden="true" />
      <span className="gt-radio-card-copy">
        <span className="gt-radio-card-title">
          {title}
          {badge && <small className="gt-radio-card-badge">{badge}</small>}
        </span>
        <span className="gt-radio-card-description">{description}</span>
      </span>
    </button>
  )
}

export function RadioGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gt-radio-group" role="radiogroup" aria-label={label}>
      {children}
    </div>
  )
}
