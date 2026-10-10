import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api } from '../api/endpoints'
import type { Side } from '../api/types'
import { GuestCta } from '../components/GuestCta'
import { OrdersPanel } from '../components/OrdersPanel'
import { usePolling } from '../hooks/usePolling'
import { PHONE, useMediaQuery } from '../hooks/useMediaQuery'
import { formatInt } from '../lib/format'
import { MarketStats } from '../market/MarketStats'
import { OrderBook } from '../market/OrderBook'
import { OrderForm } from '../market/OrderForm'
import { TradeTape } from '../market/TradeTape'
import { useMarkets } from '../state/markets'
import { useSession } from '../state/session'
import { NotFoundPage } from './NotFoundPage'

const PriceChart = lazy(() => import('../market/PriceChart'))

export function MarketPage() {
  const params = useParams()
  const marketId = Number(params.marketId)
  const { byId, markets } = useMarkets()
  const market = byId.get(marketId)
  const { session, accountVersion } = useSession()
  const phone = useMediaQuery(PHONE)
  // Until the list arrives any positive id may exist; afterwards only listed ones are polled
  const known = Number.isInteger(marketId) && marketId > 0 && (!markets || market !== undefined)

  const book = usePolling(known ? `book:${marketId}` : null, (s) => api.book(marketId, 20, s), 2000)
  const trades = usePolling(known ? `trades:${marketId}` : null, (s) => api.trades(marketId, 50, s), 2000)
  const userKey = session && known ? `${session.userId}:${marketId}` : null
  const active = usePolling(
    userKey && `active:${userKey}`,
    (s) => api.myOrders({ status: 'ACTIVE', marketId, limit: 100 }, s),
    3000,
    accountVersion,
  )
  const inventory = usePolling(session ? `inventory:${session.userId}` : null, (s) => api.inventory(s), 3000, accountVersion)

  const [picked, setPicked] = useState<{ price: number; nonce: number } | null>(null)
  const pick = useCallback((price: number) => setPicked((p) => ({ price, nonce: (p?.nonce ?? 0) + 1 })), [])

  const lastTrade = trades.data?.[0]
  const myLevels = useMemo(() => {
    const levels: Record<Side, Set<number>> = { BUY: new Set(), SELL: new Set() }
    for (const order of active.data ?? []) if (order.status === 'OPEN') levels[order.side].add(order.price)
    return levels
  }, [active.data])

  const lastPrice = lastTrade?.price ?? market?.lastPrice
  useEffect(() => {
    if (!market) return
    document.title = `${lastPrice != null ? `${formatInt(lastPrice)} ` : ''}${market.name} | Game Item Exchange`
    return () => {
      document.title = 'Game Item Exchange'
    }
  }, [market, lastPrice])

  if (!known) {
    return <NotFoundPage title="No such market" text="This market does not exist. Pick one from the list." />
  }
  if (!market) {
    return <div className="page market-page is-loading" aria-busy="true" />
  }

  const bestBid = book.data ? (book.data.bids[0]?.price ?? null) : market.bestBid
  const bestAsk = book.data ? (book.data.asks[0]?.price ?? null) : market.bestAsk

  return (
    <div className="page market-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/">Markets</Link>
        <span aria-hidden="true">/</span>
        <span>{market.gameName}</span>
      </nav>
      <div className="terminal">
        <div className="area-stats">
          <MarketStats market={market} book={book.data} lastTrade={lastTrade} />
        </div>
        <div className="area-chart">
          <Suspense fallback={<section className="pane chart" />}>
            <PriceChart marketId={marketId} trades={trades.data} />
          </Suspense>
        </div>
        <div className="area-book">
          <OrderBook book={book.data} rows={phone ? 8 : 12} lastTrade={lastTrade} myLevels={myLevels} onPick={pick} />
        </div>
        <div className="area-trades">
          <section className="pane trades" aria-label="Latest trades">
            <header className="pane-head">
              <h2>Trades</h2>
              <span className="pane-hint">
                <span className="legend-dot up" /> buyer took <span className="legend-dot down" /> seller took
              </span>
            </header>
            <TradeTape trades={trades.data} rows={phone ? 10 : 14} resetKey={String(marketId)} />
          </section>
        </div>
        <div className="area-form">
          <section className="pane form-pane" aria-label="Place an order">
            <header className="pane-head">
              <h2>Place an order</h2>
            </header>
            {session ? (
              <OrderForm market={market} inventory={inventory.data} picked={picked} bestBid={bestBid} bestAsk={bestAsk} />
            ) : (
              <GuestCta title="Trade with play money">
                Get a guest account with 50{'\u2009'}000 credits and a starter pack of {market.name.toLowerCase()} and
                other items. Your orders go into this book next to the bots.
              </GuestCta>
            )}
            <MatchingNotes />
          </section>
        </div>
        <div className="area-orders">
          {session ? (
            <OrdersPanel
              title="My orders"
              active={active}
              marketId={marketId}
              showMarket={false}
              emptyActive={
                <>No open orders in this market. Orders that rest in the book show up here, marked in the book too.</>
              }
            />
          ) : (
            <section className="pane orders" aria-label="My orders">
              <header className="pane-head">
                <h2>My orders</h2>
              </header>
              <div className="orders-empty">
                Your orders in this market appear here once you have a guest account.{' '}
                <Link to="/about">How matching works</Link>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function MatchingNotes() {
  return (
    <div className="matching-notes">
      <h3>How your order trades</h3>
      <ul>
        <li>The best price trades first; at the same price, the earliest order does.</li>
        <li>You trade at the resting order’s price, which is never worse than your limit.</li>
        <li>Sellers pay a 5% fee. Everything here is play money.</li>
      </ul>
    </div>
  )
}
