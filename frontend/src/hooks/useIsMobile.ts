import { useEffect, useState } from 'react'

// Covers phone and tablet -- the compact shell adapts internally between
// the two (see the tablet-range rules in mobile/Mobile.css). Desktop starts
// above this.
const BREAKPOINT = '(max-width: 1024px)'

// Crossing this swaps the whole component tree (desktop <-> compact shell),
// which resets in-progress state -- there's no getting around that without
// merging them into one shell (a bigger job than tonight). Debouncing at
// least means dragging a window across the boundary settles once instead of
// remounting on every pixel; a real device's width doesn't change mid-use.
const SETTLE_MS = 250

export default function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(BREAKPOINT).matches)

  useEffect(() => {
    const query = window.matchMedia(BREAKPOINT)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = (event: MediaQueryListEvent) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setIsMobile(event.matches), SETTLE_MS)
    }
    query.addEventListener('change', onChange)
    return () => {
      query.removeEventListener('change', onChange)
      if (timer) clearTimeout(timer)
    }
  }, [])

  return isMobile
}
