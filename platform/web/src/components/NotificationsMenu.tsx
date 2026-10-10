import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../api/endpoints'
import type { Notification } from '../api/types'
import { formatAgo } from '../lib/format'
import { describeNotification } from '../lib/notifications'
import { useMarkets } from '../state/markets'
import { useSession } from '../state/session'
import { BellIcon } from './icons'

export function NotificationsMenu() {
  const { notifications, refreshNotifications } = useSession()
  const { byKey } = useMarkets()
  const [open, setOpen] = useState(false)
  // Ids that were unread when the menu opened: they keep their marker until it closes
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set())
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const unread = open ? 0 : (notifications?.unread ?? 0)
  const items = notifications?.items ?? []

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    setFreshIds(new Set(items.filter((n) => !n.read).map((n) => n.notificationId)))
    setOpen(true)
    if ((notifications?.unread ?? 0) > 0) {
      api.markNotificationsRead().then(refreshNotifications, () => {})
    }
  }

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="notifications" ref={root}>
      <button
        type="button"
        className="icon-button bell"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={toggle}
      >
        <BellIcon size={18} />
        {unread > 0 && <span className="badge num">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notifications-panel" id={panelId} role="dialog" aria-label="Notifications">
          <div className="notifications-head">
            <span>Notifications</span>
            {items.length > 0 && <span className="muted">Fills of your orders</span>}
          </div>
          {items.length === 0 ? (
            <p className="notifications-empty">
              Nothing yet. When one of your orders trades, you will see it here.
            </p>
          ) : (
            <ul className="notifications-list">
              {items.map((n) => (
                <NotificationRow
                  key={n.notificationId}
                  notification={n}
                  fresh={freshIds.has(n.notificationId)}
                  view={describeNotification(n, byKey)}
                  onNavigate={() => setOpen(false)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function NotificationRow({
  notification,
  fresh,
  view,
  onNavigate,
}: {
  notification: Notification
  fresh: boolean
  view: ReturnType<typeof describeNotification>
  onNavigate: () => void
}) {
  const content = (
    <>
      <span className={`notification-side tone-${view.tone}`} aria-hidden="true" />
      <span className="notification-text">{view.text}</span>
      <span className="notification-time num">{formatAgo(notification.createdAt)}</span>
      {fresh && <span className="notification-new" aria-label="New" />}
    </>
  )
  return (
    <li className={fresh ? 'notification is-fresh' : 'notification'}>
      {view.marketId != null ? (
        <Link to={`/markets/${view.marketId}`} onClick={onNavigate}>
          {content}
        </Link>
      ) : (
        <div>{content}</div>
      )}
    </li>
  )
}
