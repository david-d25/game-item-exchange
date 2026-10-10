import { useState } from 'react'
import { Link } from 'react-router'
import { CloseIcon } from './icons'

const KEY = 'gie.demoBannerDismissed'

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function DemoBanner() {
  const [hidden, setHidden] = useState(wasDismissed)
  if (hidden) return null

  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      // Not remembered then; it only comes back on the next visit
    }
  }

  return (
    <div className="demo-banner">
      <p>
        <span className="live-dot" aria-hidden="true" />
        <span className="wide-only">A demo exchange: credits are play money and bots trade around the clock.</span>
        <span className="narrow-only">Demo: play money, bots trade around the clock.</span>
        <Link to="/about">How it works</Link>
      </p>
      <button type="button" className="icon-button" aria-label="Dismiss the demo notice" onClick={dismiss}>
        <CloseIcon size={14} />
      </button>
    </div>
  )
}
