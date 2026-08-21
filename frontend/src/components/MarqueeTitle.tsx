import { CSSProperties, useEffect, useRef, useState } from 'react'

interface Props {
  text: string
  id?: string
}

// Never wraps to a second line. If it's too long for the available width,
// it scrolls left/right marquee-style instead of wrapping or truncating.
export default function MarqueeTitle({ text, id }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)
  const [distance, setDistance] = useState(0)

  useEffect(() => {
    const measure = () => {
      if (!containerRef.current || !textRef.current) return
      // scrollWidth reads 0 on a plain `display: inline` element in Chromium
      // regardless of content length -- confirmed empirically, not assumed.
      // getBoundingClientRect().width is unaffected by the parent's
      // overflow: hidden and reports the span's true, unclipped width.
      const overflow = textRef.current.getBoundingClientRect().width - containerRef.current.getBoundingClientRect().width
      setDistance(overflow > 4 ? overflow + 24 : 0)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [text])

  return (
    <h1 id={id} className="marquee-title" ref={containerRef}>
      <span
        ref={textRef}
        className={distance > 0 ? 'marquee-title-scroll' : undefined}
        style={distance > 0 ? ({ '--marquee-distance': `${distance}px` } as CSSProperties) : undefined}
      >
        {text}
      </span>
    </h1>
  )
}
