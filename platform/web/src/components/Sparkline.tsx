import { useId } from 'react'

/** A price line without axes. Stretches to its box; the stroke keeps its width. */
export function Sparkline({
  values,
  tone,
  label,
}: {
  values: number[]
  tone: 'up' | 'down' | 'flat'
  label: string
}) {
  const gradientId = useId()
  if (values.length < 2) {
    return <div className="sparkline sparkline-empty" aria-hidden="true" />
  }
  const width = 120
  const height = 36
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((value, i) => {
    const x = (i / (values.length - 1)) * width
    const y = 2 + (1 - (value - min) / span) * (height - 4)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const line = `M${points.join('L')}`
  const area = `${line}L${width},${height}L0,${height}Z`

  return (
    <svg
      className={`sparkline tone-${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
