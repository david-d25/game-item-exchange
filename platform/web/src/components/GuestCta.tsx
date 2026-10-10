import type { ReactNode } from 'react'
import { GuestButton } from './Header'

/** Shown instead of trading controls to visitors without an account. */
export function GuestCta({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="guest-cta">
      <h3>{title}</h3>
      <p>
        {children ??
          'A guest account comes with 50\u2009000 play credits and a starter pack of every item. No sign-up, no email.'}
      </p>
      <GuestButton className="button button-primary button-block" label={'Get 50\u2009000 credits to trade'} />
    </div>
  )
}
