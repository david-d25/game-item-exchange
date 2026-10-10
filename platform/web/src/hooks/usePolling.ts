import { useCallback, useEffect, useRef, useState } from 'react'

interface PollState<T> {
  key: string | null
  data: T | undefined
  error: unknown
  updatedAt: number | undefined
}

export interface Poll<T> {
  /** Latest successful result for the current key; kept while a refresh is in flight or fails. */
  data: T | undefined
  /** Error of the latest attempt, cleared by the next success. */
  error: unknown
  updatedAt: number | undefined
  /** Fetch now instead of waiting for the next tick. */
  refresh: () => void
}

/**
 * Fetches `fetcher` now and then every `intervalMs` after the previous request finished, so slow responses never
 * pile up. Pauses while the tab is hidden and fetches right away when it becomes visible again.
 *
 * `key` identifies what is being polled: when it changes, the old data is dropped. `null` stops polling.
 * Changing `refreshSignal` triggers an immediate fetch and keeps the data (e.g. after placing an order).
 */
export function usePolling<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  refreshSignal: unknown = 0,
): Poll<T> {
  const [state, setState] = useState<PollState<T>>({ key, data: undefined, error: undefined, updatedAt: undefined })
  const fetcherRef = useRef(fetcher)
  const [manual, setManual] = useState(0)

  useEffect(() => {
    fetcherRef.current = fetcher
  })

  useEffect(() => {
    if (key == null) return
    let disposed = false
    let timer: number | undefined
    let inFlight: AbortController | undefined

    const run = async () => {
      window.clearTimeout(timer)
      timer = undefined
      inFlight?.abort()
      const controller = new AbortController()
      inFlight = controller
      try {
        const data = await fetcherRef.current(controller.signal)
        if (disposed || controller.signal.aborted) return
        setState({ key, data, error: undefined, updatedAt: Date.now() })
      } catch (error) {
        if (disposed || controller.signal.aborted) return
        setState((previous) =>
          previous.key === key
            ? { ...previous, error }
            : { key, data: undefined, error, updatedAt: undefined },
        )
      }
      if (inFlight === controller) inFlight = undefined
      if (!disposed && !document.hidden && timer === undefined) {
        timer = window.setTimeout(run, intervalMs)
      }
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        window.clearTimeout(timer)
        timer = undefined
      } else if (!inFlight) {
        void run()
      }
    }

    void run()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      inFlight?.abort()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [key, intervalMs, refreshSignal, manual])

  const refresh = useCallback(() => setManual((n) => n + 1), [])
  const current = state.key === key
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    updatedAt: current ? state.updatedAt : undefined,
    refresh,
  }
}
