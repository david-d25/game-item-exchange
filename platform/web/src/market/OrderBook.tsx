import { memo } from 'react'
import type { BookLevel, OrderBook as Book, Side, Trade } from '../api/types'
import { formatInt, formatPercent } from '../lib/format'

interface Props {
  book: Book | undefined
  rows: number
  lastTrade: Trade | undefined
  /** Prices where the viewer has active orders, to mark those levels. */
  myLevels: { BUY: Set<number>; SELL: Set<number> }
  onPick: (price: number) => void
}

export const OrderBook = memo(function OrderBook({ book, rows, lastTrade, myLevels, onPick }: Props) {
  const asks = book?.asks.slice(0, rows) ?? []
  const bids = book?.bids.slice(0, rows) ?? []
  const max = Math.max(1, ...asks.map((l) => l.quantity), ...bids.map((l) => l.quantity))
  const bestAsk = book?.asks[0]?.price
  const bestBid = book?.bids[0]?.price
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null

  // Asks: the cheapest sits next to the spread, so the list is drawn top-down from the most expensive
  const askRows: (BookLevel | null)[] = [...Array(rows - asks.length).fill(null), ...[...asks].reverse()]
  const bidRows: (BookLevel | null)[] = [...bids, ...Array(rows - bids.length).fill(null)]

  return (
    <section className="pane book" aria-label="Order book">
      <header className="pane-head">
        <h2>Order book</h2>
        <span className="pane-hint">Click a price to use it</span>
      </header>
      <div className="book-columns" aria-hidden="true">
        <span>Price</span>
        <span>Quantity</span>
        <span>Orders</span>
      </div>
      <div className="book-side book-asks" role="group" aria-label="Sell orders, cheapest at the bottom">
        {askRows.map((level, i) => (
          <Level key={level ? `a${level.price}` : `a-empty-${i}`} level={level} side="SELL" max={max}
            mine={level ? myLevels.SELL.has(level.price) : false} onPick={onPick} />
        ))}
      </div>
      <div className="book-mid">
        <span className={`book-last num ${lastTrade ? (lastTrade.takerSide === 'BUY' ? 'up' : 'down') : ''}`}>
          {formatInt(lastTrade?.price)}
        </span>
        <span className="book-spread num">
          {spread != null && bestAsk != null ? (
            <>
              Spread {formatInt(spread)} <span className="muted">({formatPercent((spread / bestAsk) * 100, false)})</span>
            </>
          ) : (
            book && 'One side is empty'
          )}
        </span>
      </div>
      <div className="book-side book-bids" role="group" aria-label="Buy orders, most expensive at the top">
        {bidRows.map((level, i) => (
          <Level key={level ? `b${level.price}` : `b-empty-${i}`} level={level} side="BUY" max={max}
            mine={level ? myLevels.BUY.has(level.price) : false} onPick={onPick} />
        ))}
      </div>
    </section>
  )
})

function Level({
  level,
  side,
  max,
  mine,
  onPick,
}: {
  level: BookLevel | null
  side: Side
  max: number
  mine: boolean
  onPick: (price: number) => void
}) {
  if (!level) return <div className="book-row is-empty" aria-hidden="true" />
  const width = `${Math.max(1.5, (level.quantity / max) * 100).toFixed(1)}%`
  return (
    <button
      type="button"
      className={`book-row ${side === 'BUY' ? 'bid' : 'ask'}${mine ? ' is-mine' : ''}`}
      onClick={() => onPick(level.price)}
      title={mine ? 'You have an order at this price' : undefined}
      aria-label={`${side === 'BUY' ? 'Buy' : 'Sell'} orders at ${level.price}: ${level.quantity} items. Use this price`}
    >
      <span className="depth" style={{ width }} />
      <span className="book-price num">{formatInt(level.price)}</span>
      <span className="num">{formatInt(level.quantity)}</span>
      <span className="num book-orders">{level.orders}</span>
    </button>
  )
}
