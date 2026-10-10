import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { api } from '../api/endpoints'
import type { MarketSummary } from '../api/types'
import { usePolling } from '../hooks/usePolling'

interface MarketsContextValue {
  markets: MarketSummary[] | undefined
  error: unknown
  byId: Map<number, MarketSummary>
  byKey: Map<string, MarketSummary>
}

const MarketsContext = createContext<MarketsContextValue | null>(null)

/** All market summaries, shared by every page: there are few markets and the list is cheap. */
export function MarketsProvider({ children }: { children: ReactNode }) {
  const poll = usePolling('markets', (signal) => api.markets(signal), 3000)
  const value = useMemo(() => {
    const markets = poll.data
    return {
      markets,
      error: poll.error,
      byId: new Map((markets ?? []).map((m) => [m.marketId, m])),
      byKey: new Map((markets ?? []).map((m) => [m.marketKey, m])),
    }
  }, [poll.data, poll.error])
  return <MarketsContext.Provider value={value}>{children}</MarketsContext.Provider>
}

export function useMarkets(): MarketsContextValue {
  const value = useContext(MarketsContext)
  if (!value) throw new Error('useMarkets outside MarketsProvider')
  return value
}
