interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
  id?: string
}

// Custom on/off control matching the app's flat, hairline-divided rows --
// not a native checkbox, not a filled "pill" switch library default. The
// real <input> stays present and focusable (just visually hidden) so
// keyboard and screen-reader behavior is exactly a native checkbox's.
export default function Toggle({ checked, onChange, label, description, disabled, id }: ToggleProps) {
  return (
    <label className={disabled ? 'gt-toggle gt-toggle-disabled' : 'gt-toggle'} htmlFor={id}>
      <span className="gt-toggle-copy">
        <span className="gt-toggle-label">{label}</span>
        {description && <span className="gt-toggle-description">{description}</span>}
      </span>
      <span className="gt-toggle-switch">
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-checked={checked}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="gt-toggle-input"
        />
        <span className="gt-toggle-control" data-checked={checked} aria-hidden="true" />
      </span>
    </label>
  )
}
