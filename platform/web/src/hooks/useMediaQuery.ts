import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}

/** Matches the phone breakpoint in styles/layout.css. */
export const PHONE = '(max-width: 759px)'
