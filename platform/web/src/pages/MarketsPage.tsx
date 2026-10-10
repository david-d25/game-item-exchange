import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { describeError } from '../api/client'
import { api } from '../api/endpoints'
import type { MarketSummary } from '../api/types'
import { ItemGlyph } from '../components/ItemGlyph'
import { Sparkline } from '../components/Sparkline'
import { usePolling } from '../hooks/usePolling'
import { PHONE, useMediaQuery } from '../hooks/useMediaQuery'
import { direction, formatInt, formatPercent, percentChange } from '../lib/format'
import { TradeTape, type TapeTrade } from '../market/TradeTape'
import { useMarkets } from '../state/markets'

export function MarketsPage() {
  const { markets, error } = useMarkets()
  const phone = useMediaQuery(PHONE)
  const ids = markets?.map((m) => m.marketId).join(',') ?? null

  // Last 24 hours of 5-minute closes for the sparklines: cheap, and they barely change within a minute
  const sparks = usePolling(
    ids && `sparks:${ids}`,
    async (signal) => {
      const lists = await Promise.all(markets!.map((m) => api.candles(m.marketId, '5m', 288, signal)))
      return new Map(markets!.map((m, i) => [m.marketId, lists[i]!.map((c) => c.close)]))
    },
    60_000,
  )

  // One tape across all markets
  const tape = usePolling(
    ids && `tape:${ids}`,
    async (signal) => {
      const lists = await Promise.all(markets!.map((m) => api.trades(m.marketId, 16, signal)))
      return markets!
        .flatMap((m, i) => lists[i]!.map((t): TapeTrade => ({ ...t, market: { marketId: m.marketId, name: m.name } })))
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    },
    2000,
  )

  const trades24h = markets?.reduce((sum, m) => sum + m.trades24h, 0)
  const lastTradeAt = tape.data?.[0]?.occurredAt

  return (
    <div className="page markets-page">
      <section className="intro">
        <div className="intro-text">
          <h1>Markets</h1>
          <p className="lede">
            Every price on this page comes from a real match in an order book. Bots quote and trade around the clock
            with play money, and you can trade against them with a guest account.
          </p>
        </div>
        <LiveStatus trades24h={trades24h} lastTradeAt={lastTradeAt} />
      </section>

      <section className="pane market-list" aria-label="All markets">
        <div className="market-row market-row-head" aria-hidden="true">
          <span>Item</span>
          <span className="r">Last price</span>
          <span className="r">24h change</span>
          <span className="r col-volume">24h volume</span>
          <span className="r col-quote">Best bid</span>
          <span className="r col-quote">Best ask</span>
          <span className="col-spark">Last 24 hours</span>
        </div>
        {markets?.map((market) => (
          <MarketRow key={market.marketId} market={market} closes={sparks.data?.get(market.marketId)} />
        ))}
        {!markets && (
          <div className="market-list-status">{error ? describeError(error) : 'Loading markets…'}</div>
        )}
      </section>

      <div className="markets-lower">
        <section className="pane tape-pane" aria-label="Latest trades in all markets">
          <header className="pane-head">
            <h2>Latest trades</h2>
            <span className="pane-hint">
              <span className="legend-dot up" /> buyer took <span className="legend-dot down" /> seller took
            </span>
          </header>
          <TradeTape trades={tape.data} rows={phone ? 8 : 12} resetKey={ids ?? ''} showMarket />
        </section>
        <section className="pane flow-teaser" aria-labelledby="flow-teaser-title">
          <header className="pane-head">
            <h2 id="flow-teaser-title">What happens when you place an order</h2>
          </header>
          <ol className="steps">
            <li>
              <b>Core accepts it.</b> One Postgres transaction stores the order, reserves your credits or items and
              writes an outbox row.
            </li>
            <li>
              <b>Kafka carries it.</b> A relay publishes the outbox to the <code>orders</code> topic, one partition
              per market, so each market keeps its order.
            </li>
            <li>
              <b>The matcher matches it.</b> A single thread per partition holds the book in memory and matches by
              price, then time.
            </li>
            <li>
              <b>Core settles it.</b> Each trade is applied exactly once through a double-entry ledger, and you get a
              notification.
            </li>
          </ol>
          <p className="flow-teaser-more">
            <Link to="/about">Read how the exchange is built</Link>
          </p>
        </section>
      </div>
    </div>
  )
}

function MarketRow({ market, closes }: { market: MarketSummary; closes: number[] | undefined }) {
  const change = percentChange(market.open24h, market.lastPrice)
  const tone = direction(change)
  return (
    <Link to={`/markets/${market.marketId}`} className="market-row">
      <span className="market-name">
        <ItemGlyph defId={market.defId} name={market.name} size={34} />
        <span>
          <b>{market.name}</b>
          <span className="muted">{market.gameName}</span>
        </span>
      </span>
      <span className="r num market-last">{formatInt(market.lastPrice)}</span>
      <span className={`r num market-change ${tone}`}>{formatPercent(change)}</span>
      <span className="r num col-volume">{formatInt(market.volume24h)}</span>
      <span className="r num col-quote up">{formatInt(market.bestBid)}</span>
      <span className="r num col-quote down">{formatInt(market.bestAsk)}</span>
      <span className="col-spark">
        <Sparkline values={closes ?? []} tone={tone} label={`${market.name} price over the last 24 hours`} />
      </span>
    </Link>
  )
}

function LiveStatus({ trades24h, lastTradeAt }: { trades24h: number | undefined; lastTradeAt: string | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const ago = useMemo(() => {
    if (!lastTradeAt) return null
    const seconds = Math.max(0, Math.round((now - Date.parse(lastTradeAt)) / 1000))
    if (seconds < 3) return 'just now'
    return seconds < 60 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`
  }, [now, lastTradeAt])

  return (
    <div className="live-status" aria-live="off">
      <p className="live-label">
        <span className="live-dot" aria-hidden="true" />
        Matching live
      </p>
      <p className="live-figure num">{trades24h != null ? formatInt(trades24h) : '—'}</p>
      <p className="muted">trades in the last 24 hours</p>
      <p className="muted live-last">{ago ? <>Last trade <span className="num">{ago}</span></> : '\u00a0'}</p>
    </div>
  )
}
