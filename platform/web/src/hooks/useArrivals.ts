import { useEffect, useRef, useState } from 'react'

/**
 * Ids that appeared in `ids` since the previous update, for a short highlight. The first batch never counts
 * as new, and neither does a batch after `resetKey` changes (another market, another interval).
 * Pass a memoized array: a new array means a new update.
 */
export function useArrivals(ids: string[] | undefined, resetKey: string, holdMs = 1600): Set<string> {
  const seen = useRef<{ key: string; ids: Set<string> } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const [arrivals, setArrivals] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!ids) return
    const previous = seen.current
    seen.current = { key: resetKey, ids: new Set(ids) }
    const fresh = previous && previous.key === resetKey ? ids.filter((id) => !previous.ids.has(id)) : []
    if (fresh.length === 0 && (previous?.key === resetKey)) return
    window.clearTimeout(timer.current)
    setArrivals(new Set(fresh))
    if (fresh.length > 0) {
      timer.current = window.setTimeout(() => setArrivals(new Set()), holdMs)
    }
  }, [ids, resetKey, holdMs])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return arrivals
}
