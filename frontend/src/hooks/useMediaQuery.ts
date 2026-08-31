import { useState, useEffect } from 'react'

export function useMediaQuery(query: string): boolean {
  const getMatch = () => window.matchMedia(query).matches

  const [matches, setMatches] = useState<boolean>(getMatch)

  useEffect(() => {
    const mql = window.matchMedia(query)

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener('change', handler)

    setMatches(mql.matches)

    return () => mql.removeEventListener('change', handler)
  }, [query])

  return matches
}
