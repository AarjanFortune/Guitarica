// Thin-line icons matching the app's existing icon style (see .upload-icon
// in App.css: stroke=currentColor, fill=none, stroke-width ~1.2). Used in
// place of text-only "Play audio" / "Save" buttons.

export function PlayIcon() {
  return (
    <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
      <path d="M10 7.5v17l15-8.5-15-8.5Z" strokeLinejoin="round" />
    </svg>
  )
}

export function PauseIcon() {
  return (
    <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
      <path d="M10.5 7v18" />
      <path d="M21.5 7v18" />
    </svg>
  )
}

export function SaveIcon() {
  return (
    <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
      <path d="M7 4h15l5 5v19a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <path d="M11 4v8h10V4" strokeLinejoin="round" />
      <path d="M11 29v-9h10v9" strokeLinejoin="round" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
      <path d="M7 17l6 6 12-14" strokeLinejoin="round" />
    </svg>
  )
}

export function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
      <path d="M8 12l8 8 8-8" strokeLinejoin="round" />
    </svg>
  )
}

export function ZoomInIcon() {
  return (
    <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
      <circle cx="14" cy="14" r="9" />
      <path d="M20.5 20.5 27 27" strokeLinecap="round" />
      <path d="M14 10v8M10 14h8" strokeLinecap="round" />
    </svg>
  )
}

export function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 32 32" focusable="false" aria-hidden="true">
      <circle cx="14" cy="14" r="9" />
      <path d="M20.5 20.5 27 27" strokeLinecap="round" />
      <path d="M10 14h8" strokeLinecap="round" />
    </svg>
  )
}
