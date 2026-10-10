// Numbers use a thin space as the thousands separator (50 000), the SI style: unambiguous for readers who
// expect either a comma or a dot. Credits and quantities are always integers.

const THIN_SPACE = '\u2009'
const MINUS = '−'
const grouping = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: true })

export function formatInt(value: number | null | undefined, empty = '—'): string {
  if (value == null || !Number.isFinite(value)) return empty
  const text = grouping.format(Math.abs(Math.round(value))).replace(/,/g, THIN_SPACE)
  return value < 0 ? MINUS + text : text
}

/** Compact form for axis-like contexts: 1 840, 18.4k, 1.2M. */
export function formatCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs < 100_000) return formatInt(value)
  if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Change from `from` to `to` in percent, or null when there is no reference price. */
export function percentChange(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null
  return ((to - from) / from) * 100
}

export function formatPercent(value: number | null, signed = true): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const text = Math.abs(value).toFixed(2)
  if (!signed) return `${text}%`
  if (Number(text) === 0) return `0.00%`
  return `${value > 0 ? '+' : MINUS}${text}%`
}

export function direction(value: number | null | undefined): 'up' | 'down' | 'flat' {
  if (value == null || value === 0 || !Number.isFinite(value)) return 'flat'
  return value > 0 ? 'up' : 'down'
}

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const dayAndTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** 15:04:05 in the viewer's time zone. */
export function formatClock(iso: string | number): string {
  return clock.format(new Date(iso))
}

/** 15:04:05 for today, 9 Oct 15:04 otherwise. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return clock.format(date)
  return dayAndTime.format(date)
}

export function formatAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return dayAndTime.format(new Date(iso))
}

/** Parses a positive integer typed by a person; tolerates spaces and separators. */
export function parseInteger(text: string): number | null {
  const cleaned = text.replace(/[\s\u2009,_']/g, '')
  if (!/^\d+$/.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isSafeInteger(value) ? value : null
}
