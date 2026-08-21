import { useEffect, useRef, useState } from 'react'

interface CustomSelectOption<T extends string> {
  value: T
  label: string
}

interface CustomSelectProps<T extends string> {
  value: T
  options: CustomSelectOption<T>[]
  onChange: (value: T) => void
  labelId?: string
}

export default function CustomSelect<T extends string>({
  value,
  options,
  onChange,
  labelId,
}: CustomSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = options.find((option) => option.value === value) || options[0]

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  return (
    <div className="custom-select" ref={rootRef}>
      <button
        type="button"
        className="custom-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={labelId}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected.label}</span>
        <i aria-hidden="true" />
      </button>

      {open && (
        <div className="custom-select-menu" role="listbox" aria-labelledby={labelId}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="custom-select-option"
              key={option.value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
