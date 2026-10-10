import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getSession, setSession, subscribeSession, type StoredSession } from '../api/client'
import { api } from '../api/endpoints'
import type { Notifications, Wallet } from '../api/types'
import { usePolling } from '../hooks/usePolling'

interface SessionContextValue {
  session: StoredSession | null
  wallet: Wallet | undefined
  notifications: Notifications | undefined
  /** Creates a guest account with the starter pack. Rejects with ApiError/NetworkError. */
  signIn: () => Promise<void>
  signingIn: boolean
  signOut: () => void
  /** Changes whenever the account changed on our side (order placed, canceled): pollers fetch right away. */
  accountVersion: number
  accountChanged: () => void
  refreshNotifications: () => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setCurrent] = useState<StoredSession | null>(getSession)
  const [signingIn, setSigningIn] = useState(false)
  const [accountVersion, setAccountVersion] = useState(0)

  useEffect(() => subscribeSession(setCurrent), [])

  const sessionKey = session ? `user:${session.userId}:${session.token.slice(-12)}` : null
  const wallet = usePolling(sessionKey, (signal) => api.wallet(signal), 3000, accountVersion)
  const notifications = usePolling(sessionKey, (signal) => api.notifications(20, signal), 4000, accountVersion)

  const signIn = useCallback(async () => {
    setSigningIn(true)
    try {
      const guest = await api.createGuest()
      setSession({
        token: guest.token,
        userId: guest.userId,
        displayName: guest.displayName,
        expiresAt: guest.expiresAt,
      })
    } finally {
      setSigningIn(false)
    }
  }, [])

  const signOut = useCallback(() => setSession(null), [])
  const accountChanged = useCallback(() => setAccountVersion((v) => v + 1), [])
  const refreshNotifications = notifications.refresh

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      wallet: wallet.data,
      notifications: notifications.data,
      signIn,
      signingIn,
      signOut,
      accountVersion,
      accountChanged,
      refreshNotifications,
    }),
    [session, wallet.data, notifications.data, signIn, signingIn, signOut, accountVersion, accountChanged,
      refreshNotifications],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession outside SessionProvider')
  return value
}
