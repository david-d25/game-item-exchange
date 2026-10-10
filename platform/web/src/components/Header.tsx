import { NavLink, useLocation } from 'react-router'
import { describeError } from '../api/client'
import { formatInt } from '../lib/format'
import { useSession } from '../state/session'
import { useToast } from '../state/toast'
import { Logo } from './Logo'
import { NotificationsMenu } from './NotificationsMenu'

export function Header() {
  const { session, wallet } = useSession()
  const { pathname } = useLocation()
  // A market page belongs to Markets
  const marketsActive = pathname === '/' || pathname.startsWith('/markets/')

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Logo />
        <nav className="site-nav" aria-label="Main">
          <NavLink to="/" end className={marketsActive ? 'active' : undefined}>
            Markets
          </NavLink>
          <NavLink to="/portfolio">Portfolio</NavLink>
          <NavLink to="/about">About</NavLink>
        </nav>
        <div className="account">
          {session ? (
            <>
              <div className="account-balance">
                <span className="account-name">{session.displayName}</span>
                <span
                  className="account-line"
                  title={wallet ? `${formatInt(wallet.reserved)} credits reserved by open orders` : undefined}
                >
                  <span className="account-credits num">
                    {wallet ? formatInt(wallet.available) : '\u2007'}
                    <span className="unit">credits</span>
                  </span>
                  {wallet && wallet.reserved > 0 && (
                    <span className="account-reserved num">+{formatInt(wallet.reserved)} reserved</span>
                  )}
                </span>
              </div>
              <NotificationsMenu />
            </>
          ) : (
            <GuestButton />
          )}
        </div>
      </div>
    </header>
  )
}

export function GuestButton({ className = 'button button-primary', label }: { className?: string; label?: string }) {
  const { signIn, signingIn } = useSession()
  const toast = useToast()

  const onClick = async () => {
    try {
      await signIn()
    } catch (error) {
      toast(describeError(error))
    }
  }

  return (
    <button type="button" className={className} onClick={onClick} disabled={signingIn}>
      {signingIn ? (
        'Creating account…'
      ) : (
        label ?? (
          <>
            <span className="wide-only">Try it — get 50{'\u2009'}000 credits</span>
            <span className="narrow-only">Get 50{'\u2009'}000 credits</span>
          </>
        )
      )}
    </button>
  )
}
