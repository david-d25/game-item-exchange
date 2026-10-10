import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  TickMarkType,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { api } from '../api/endpoints'
import type { Candle, CandleInterval, Trade } from '../api/types'
import { PHONE, useMediaQuery } from '../hooks/useMediaQuery'
import { usePolling } from '../hooks/usePolling'
import { formatCompact, formatInt } from '../lib/format'
import { theme } from '../lib/theme'

const INTERVALS: { value: CandleInterval; label: string; ms: number; limit: number; title: string }[] = [
  { value: '1m', label: '1m', ms: 60_000, limit: 180, title: '1-minute candles, last 3 hours' },
  { value: '5m', label: '5m', ms: 300_000, limit: 288, title: '5-minute candles, last 24 hours' },
  { value: '1h', label: '1h', ms: 3_600_000, limit: 168, title: '1-hour candles, last 7 days' },
]
const INTERVAL_KEY = 'gie.chartInterval'

interface Bar {
  time: number // seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Candles from `/candles`, refreshed every 10 s. Between refreshes the newest candle follows the trades the
 * page already polls every 2 s, so the chart moves with the tape. Times are shown in the viewer's time zone.
 */
export default function PriceChart({ marketId, trades }: { marketId: number; trades: Trade[] | undefined }) {
  const [interval, setChartInterval] = useState<CandleInterval>(readInterval)
  const spec = INTERVALS.find((i) => i.value === interval) ?? INTERVALS[0]!
  const key = `${marketId}:${interval}`
  const candles = usePolling(key, (signal) => api.candles(marketId, interval, spec.limit, signal), 10_000)

  const bars = useMemo(() => mergeTrades(candles.data, trades, spec.ms), [candles.data, trades, spec.ms])

  const container = useRef<HTMLDivElement>(null)
  const chart = useRef<{ api: IChartApi; price: ISeriesApi<'Candlestick'>; volume: ISeriesApi<'Histogram'> }>(null)
  const framedKey = useRef<string | null>(null)
  const [hovered, setHovered] = useState<Bar | null>(null)
  const phone = useMediaQuery(PHONE)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const created = createChart(element, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: theme.text2,
        fontFamily: theme.font,
        fontSize: 11,
        attributionLogo: false, // credited in the footer and on the About page instead
      },
      grid: { vertLines: { color: theme.line }, horzLines: { color: theme.line } },
      rightPriceScale: { borderColor: theme.line, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: {
        borderColor: theme.line,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: tickMark,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: theme.text3, labelBackgroundColor: '#2a2f3a' },
        horzLine: { color: theme.text3, labelBackgroundColor: '#2a2f3a' },
      },
      localization: { timeFormatter: crosshairTime, priceFormatter: (p: number) => formatInt(p) },
    })
    const price = created.addSeries(CandlestickSeries, {
      upColor: theme.buy,
      downColor: theme.sell,
      wickUpColor: theme.buy,
      wickDownColor: theme.sell,
      borderVisible: false,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
      priceLineColor: theme.text3,
    })
    const volume = created.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    created.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false })
    created.subscribeCrosshairMove((param) => {
      const point = param.seriesData.get(price) as CandlestickData<Time> | undefined
      const vol = param.seriesData.get(volume) as HistogramData<Time> | undefined
      if (!point || param.time == null) {
        setHovered(null)
        return
      }
      setHovered({
        time: Number(param.time),
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
        volume: vol?.value ?? 0,
      })
    })
    chart.current = { api: created, price, volume }
    return () => {
      chart.current = null
      framedKey.current = null
      created.remove()
    }
  }, [])

  useEffect(() => {
    const c = chart.current
    if (!c) return
    if (!bars) {
      c.price.setData([])
      c.volume.setData([])
      return
    }
    c.price.setData(
      bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })),
    )
    c.volume.setData(
      bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.volume,
        color: b.close >= b.open ? theme.buySoft : theme.sellSoft,
      })),
    )
    if (framedKey.current !== key && bars.length > 0) {
      framedKey.current = key
      const visible = Math.min(bars.length, phone ? 56 : 120)
      c.api.timeScale().setVisibleLogicalRange({ from: bars.length - visible - 0.5, to: bars.length + 3 })
    }
  }, [bars, key, phone])

  const choose = (value: CandleInterval) => {
    setChartInterval(value)
    try {
      localStorage.setItem(INTERVAL_KEY, value)
    } catch {
      // Remembering the interval is a nicety
    }
  }

  const legend = hovered ?? bars?.at(-1) ?? null
  const empty = bars !== undefined && bars.length === 0

  return (
    <section className="pane chart" aria-label="Price chart">
      <header className="pane-head">
        <h2>Price</h2>
        <div className="segmented segmented-small" role="radiogroup" aria-label="Candle interval">
          {INTERVALS.map((i) => (
            <button
              key={i.value}
              type="button"
              role="radio"
              aria-checked={interval === i.value}
              title={i.title}
              className={interval === i.value ? 'is-active' : undefined}
              onClick={() => choose(i.value)}
            >
              {i.label}
            </button>
          ))}
        </div>
      </header>
      <div className="chart-body">
        <div className="chart-legend num" aria-hidden="true">
          {legend && (
            <>
              <span>O <b>{formatInt(legend.open)}</b></span>
              <span>H <b>{formatInt(legend.high)}</b></span>
              <span>L <b>{formatInt(legend.low)}</b></span>
              <span>C <b className={legend.close >= legend.open ? 'up' : 'down'}>{formatInt(legend.close)}</b></span>
              <span>Vol <b>{formatCompact(legend.volume)}</b></span>
            </>
          )}
        </div>
        <div className="chart-canvas" ref={container} />
        {empty && <p className="chart-empty">No trades in this period yet.</p>}
      </div>
    </section>
  )
}

function readInterval(): CandleInterval {
  try {
    const stored = localStorage.getItem(INTERVAL_KEY)
    if (stored === '1m' || stored === '5m' || stored === '1h') return stored
  } catch {
    // ignore
  }
  return '5m'
}

/** Server candles plus trades newer than them; only price is merged into a known candle, never volume. */
function mergeTrades(candles: Candle[] | undefined, trades: Trade[] | undefined, intervalMs: number): Bar[] | undefined {
  if (!candles) return undefined
  const bars: Bar[] = candles.map((c) => ({
    time: Date.parse(c.time) / 1000,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }))
  const last = bars.at(-1)
  if (!trades || !last) return bars
  const fresh = trades
    .filter((t) => Date.parse(t.occurredAt) >= last.time * 1000)
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
  for (const trade of fresh) {
    const bucket = (Math.floor(Date.parse(trade.occurredAt) / intervalMs) * intervalMs) / 1000
    const tail = bars.at(-1)!
    if (bucket === tail.time) {
      tail.high = Math.max(tail.high, trade.price)
      tail.low = Math.min(tail.low, trade.price)
      tail.close = trade.price
    } else if (bucket > tail.time) {
      bars.push({ time: bucket, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.quantity })
    }
  }
  return bars
}

const timeOnly = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const full = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function tickMark(time: Time, type: TickMarkType): string {
  const date = new Date(Number(time) * 1000)
  switch (type) {
    case TickMarkType.Year:
      return String(date.getFullYear())
    case TickMarkType.Month:
    case TickMarkType.DayOfMonth:
      return dayMonth.format(date)
    default:
      return timeOnly.format(date)
  }
}

function crosshairTime(time: Time): string {
  return full.format(new Date(Number(time) * 1000))
}
