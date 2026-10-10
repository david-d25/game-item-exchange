import type { ReactNode } from 'react'
import type { MarketSummary, OrderBook, Trade } from '../api/types'
import { ItemGlyph } from '../components/ItemGlyph'
import { direction, formatInt, formatPercent, percentChange } from '../lib/format'

/** The strip on top of the market page: what this is and where the price is. */
export function MarketStats({
  market,
  book,
  lastTrade,
}: {
  market: MarketSummary
  book: OrderBook | undefined
  lastTrade: Trade | undefined
}) {
  const last = lastTrade?.price ?? market.lastPrice
  const change = percentChange(market.open24h, last)
  const bestBid = book ? (book.bids[0]?.price ?? null) : market.bestBid
  const bestAsk = book ? (book.asks[0]?.price ?? null) : market.bestAsk
  const tick = lastTrade ? (lastTrade.takerSide === 'BUY' ? 'up' : 'down') : 'flat'

  return (
    <section className="pane stats" aria-label={`${market.name} market summary`}>
      <div className="stats-title">
        <ItemGlyph defId={market.defId} name={market.name} size={36} />
        <div>
          <h1>{market.name}</h1>
          <p className="muted">{market.gameName}</p>
        </div>
      </div>
      <div className="stats-price">
        <span className={`stats-last num ${tick}`}>{formatInt(last)}</span>
        <span className={`num ${direction(change)}`}>{formatPercent(change)}</span>
      </div>
      <dl className="stats-list">
        <Stat label="24h open">{formatInt(market.open24h)}</Stat>
        <Stat label="24h volume">{formatInt(market.volume24h)}</Stat>
        <Stat label="24h trades">{formatInt(market.trades24h)}</Stat>
        <Stat label="Best bid" className="up">{formatInt(bestBid)}</Stat>
        <Stat label="Best ask" className="down">{formatInt(bestAsk)}</Stat>
      </dl>
    </section>
  )
}

function Stat({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={className ? `num ${className}` : 'num'}>{children}</dd>
    </div>
  )
}
