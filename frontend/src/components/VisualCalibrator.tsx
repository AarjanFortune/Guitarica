import { useEffect, useRef, useState } from 'react'
import { SourceType } from '../types/transcription'
import {
  DEFAULT_VISUAL_CONFIG,
  VisualConfig,
  VisualElementKey,
  VISUAL_ELEMENT_LABELS,
} from '../visualConfig'
import CustomSelect from './CustomSelect'

interface VisualCalibratorProps {
  config: VisualConfig
  onChange: (config: VisualConfig) => void
  onClose: () => void
  onOpenMenu: () => void
  onOpenSource: (source: SourceType) => void
}

export default function VisualCalibrator({
  config,
  onChange,
  onClose,
  onOpenMenu,
  onOpenSource,
}: VisualCalibratorProps) {
  const [selected, setSelected] = useState<VisualElementKey>('menuGuitar')
  const [position, setPosition] = useState({ x: 24, y: 96 })
  const [copied, setCopied] = useState(false)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const current = config[selected]

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragRef.current) return
      setPosition({
        x: Math.max(0, event.clientX - dragRef.current.x),
        y: Math.max(0, event.clientY - dragRef.current.y),
      })
    }
    const stop = () => { dragRef.current = null }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
  }, [])

  const update = (field: keyof typeof current, value: number) => {
    onChange({
      ...config,
      [selected]: { ...current, [field]: value },
    })
  }

  const resetSelected = () => {
    onChange({ ...config, [selected]: DEFAULT_VISUAL_CONFIG[selected] })
  }

  const copyConfig = async () => {
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <aside
      className="visual-calibrator"
      style={{ left: position.x, top: position.y }}
      aria-label="Visual calibrator"
    >
      <header
        className="calibrator-header"
        onPointerDown={(event) => {
          dragRef.current = {
            x: event.clientX - position.x,
            y: event.clientY - position.y,
          }
        }}
      >
        <strong>Visual calibrator</strong>
        <button type="button" onClick={onClose}>Close</button>
      </header>

      <div className="calibrator-scenes" aria-label="Preview screen">
        <button type="button" onClick={onOpenMenu}>Menu</button>
        <button type="button" onClick={() => onOpenSource('upload')}>File</button>
        <button type="button" onClick={() => onOpenSource('youtube')}>YouTube</button>
        <button type="button" onClick={() => onOpenSource('live')}>Live</button>
      </div>

      <div className="calibrator-select">
        <span id="calibrator-element-label">Element</span>
        <CustomSelect
          value={selected}
          onChange={setSelected}
          labelId="calibrator-element-label"
          options={Object.entries(VISUAL_ELEMENT_LABELS).map(([key, label]) => ({
            value: key as VisualElementKey,
            label,
          }))}
        />
      </div>

      <div className="calibrator-controls">
        <Control label="X" value={current.x} min={-900} max={900} step={1} onChange={(value) => update('x', value)} />
        <Control label="Y" value={current.y} min={-700} max={700} step={1} onChange={(value) => update('y', value)} />
        <Control label="Scale" value={current.scale} min={0.1} max={3} step={0.01} onChange={(value) => update('scale', value)} />
        <Control label="Rotation" value={current.rotation} min={-180} max={180} step={1} onChange={(value) => update('rotation', value)} />
        <Control label="Layer" value={current.zIndex} min={-10} max={100} step={1} onChange={(value) => update('zIndex', value)} />
      </div>

      <div className="calibrator-actions">
        <button type="button" onClick={resetSelected}>Reset element</button>
        <button type="button" onClick={() => onChange(DEFAULT_VISUAL_CONFIG)}>Reset all</button>
        <button type="button" onClick={copyConfig}>{copied ? 'Copied' : 'Copy JSON'}</button>
      </div>
    </aside>
  )
}

function Control({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <label className="calibrator-control">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}
