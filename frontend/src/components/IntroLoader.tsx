import { useCallback, useEffect, useState } from 'react'

interface IntroLoaderProps {
  onComplete: () => void
}

export default function IntroLoader({ onComplete }: IntroLoaderProps) {
  const [isLeaving, setIsLeaving] = useState(false)

  const finish = useCallback(() => {
    if (isLeaving) return
    setIsLeaving(true)
    window.setTimeout(onComplete, 520)
  }, [isLeaving, onComplete])

  useEffect(() => {
    const timer = window.setTimeout(finish, 1900)
    return () => window.clearTimeout(timer)
  }, [finish])

  return (
    <button
      type="button"
      className={`intro-loader${isLeaving ? ' intro-loader-leaving' : ''}`}
      onClick={finish}
      aria-label="Enter Guitarica"
    >
      <span className="intro-mark">
        <img src="/images/logoG.png" alt="Guitarica" />
      </span>
      <span className="intro-progress" aria-hidden="true">
        <i />
      </span>
    </button>
  )
}
