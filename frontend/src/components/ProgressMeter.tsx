import { useEffect, useState } from 'react'

interface ProgressMeterProps {
  active: boolean
  label?: string
  estimatedSeconds?: number
}

export default function ProgressMeter({
  active,
  label = 'Analyzing audio',
  estimatedSeconds,
}: ProgressMeterProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!active) {
      setElapsedSeconds(0)
      return undefined
    }

    const timer = window.setInterval(() => {
      setElapsedSeconds((current) => current + 1)
    }, 1000)

    return () => window.clearInterval(timer)
  }, [active])

  if (!active) return null

  return (
    <div className="progress-meter" role="status" aria-live="polite">
      <div className="progress-copy">
        <span>{label}</span>
        <span>Queued {formatElapsed(elapsedSeconds)}</span>
        <span>Estimated {estimatedSeconds ? formatElapsed(estimatedSeconds) : 'calculating'}</span>
      </div>
      <div className="progress-track">
        <div />
      </div>
    </div>
  )
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
}
