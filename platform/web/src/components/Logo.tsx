import { Link } from 'react-router'

/** A cut gem split by a gap: the spread between asks above and bids below. */
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" className="logo-mark">
      <path d="M10 1.6 17.2 6v3H2.8V6L10 1.6Z" fill="currentColor" />
      <path d="M2.8 11h14.4v3L10 18.4 2.8 14v-3Z" fill="currentColor" opacity="0.5" />
    </svg>
  )
}

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Game Item Exchange, markets">
      <LogoMark />
      <span className="logo-word">Game Item Exchange</span>
    </Link>
  )
}
