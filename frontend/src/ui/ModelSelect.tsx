import { useEffect, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon } from './icons'

export interface ModelSelectOption {
  id: string
  label: string
  detail?: string
}

interface ModelSelectProps {
  options: ModelSelectOption[]
  value: string
  onChange: (id: string) => void
}

// Custom listbox, not a native <select> -- matches the app's flat,
// hairline-divided visual language (same family as gt-disclosure /
// gt-radio-card) instead of the browser's own dropdown chrome.
export default function ModelSelect({ options, value, onChange }: ModelSelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const current = options.find((option) => option.id === value) || options[0]

  useEffect(() => {
    if (!open) return undefined
    const onClickAway = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickAway)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickAway)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (options.length <= 1) return null

  return (
    <div className="gt-model-select" ref={rootRef}>
      <button
        type="button"
        className="gt-model-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{current?.label || 'Select model'}</span>
        <span className="gt-model-select-chevron" aria-hidden="true"><ChevronDownIcon /></span>
      </button>
      {open && (
        <ul className="gt-model-select-list" role="listbox">
          {options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={option.id === value}
                className={option.id === value ? 'gt-model-select-option-active' : undefined}
                onClick={() => { onChange(option.id); setOpen(false) }}
              >
                <span className="gt-model-select-option-copy">
                  <span>{option.label}</span>
                  {option.detail && <small>{option.detail}</small>}
                </span>
                {option.id === value && <span className="gt-model-select-check" aria-hidden="true"><CheckIcon /></span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
