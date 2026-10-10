import { useMemo } from 'react'
import { Link } from 'react-router'
import type { Trade } from '../api/types'
import { useArrivals } from '../hooks/useArrivals'
import { formatClock, formatInt } from '../lib/format'

export interface TapeTrade extends Trade {
  /** Set on the all-markets tape. */
  market?: { marketId: number; name: string }
}

/** Latest trades, newest on top. Rows that arrived with the last refresh light up for a moment. */
export function TradeTape({
  trades,
  rows,
  resetKey,
  showMarket = false,
}: {
  trades: TapeTrade[] | undefined
  rows: number
  resetKey: string
  showMarket?: boolean
}) {
  const visible = useMemo(() => trades?.slice(0, rows), [trades, rows])
  const ids = useMemo(() => visible?.map((t) => t.tradeId + (t.market?.marketId ?? '')), [visible])
  const arrivals = useArrivals(ids, resetKey)

  return (
    <div className={showMarket ? 'tape tape-wide' : 'tape'}>
      <div className="tape-columns" aria-hidden="true">
        {showMarket && <span>Item</span>}
        <span>Price</span>
        <span>Quantity</span>
        <span>Time</span>
      </div>
      <ol className="tape-rows" aria-label="Latest trades, newest first">
        {visible?.map((trade) => {
          const id = trade.tradeId + (trade.market?.marketId ?? '')
          const tone = trade.takerSide === 'BUY' ? 'tone-buy' : 'tone-sell'
          return (
            <li key={id} className={arrivals.has(id) ? `tape-row is-new ${tone}` : `tape-row ${tone}`}>
              {showMarket && trade.market && (
                <Link to={`/markets/${trade.market.marketId}`} className="tape-market">
                  {trade.market.name}
                </Link>
              )}
              <span className="num tape-price">
                <span className="visually-hidden">{trade.takerSide === 'BUY' ? 'Bought at' : 'Sold at'} </span>
                {formatInt(trade.price)}
              </span>
              <span className="num">{formatInt(trade.quantity)}</span>
              <time className="num muted" dateTime={trade.occurredAt}>
                {formatClock(trade.occurredAt)}
              </time>
            </li>
          )
        })}
        {visible && visible.length === 0 && <li className="tape-empty">No trades yet.</li>}
        {!visible && Array.from({ length: Math.min(rows, 8) }, (_, i) => <li key={i} className="tape-row is-placeholder" />)}
      </ol>
    </div>
  )
}
