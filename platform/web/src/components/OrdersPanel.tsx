import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ApiError, describeError } from '../api/client'
import { api } from '../api/endpoints'
import type { Order } from '../api/types'
import { usePolling, type Poll } from '../hooks/usePolling'
import { formatInt, formatTimestamp } from '../lib/format'
import { orderStatusLabel } from '../lib/orders'
import { useMarkets } from '../state/markets'
import { useSession } from '../state/session'
import { useToast } from '../state/toast'

type Tab = 'ACTIVE' | 'CLOSED'

/**
 * The viewer's orders, open ones with a Cancel button and closed ones on the second tab.
 * The parent polls the open orders (it also needs them elsewhere); closed ones are fetched only when shown.
 */
export function OrdersPanel({
  title,
  active,
  marketId,
  showMarket,
  emptyActive,
}: {
  title: string
  active: Poll<Order[]>
  marketId?: number
  showMarket: boolean
  emptyActive: ReactNode
}) {
  const { session, accountVersion, accountChanged } = useSession()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('ACTIVE')
  const [canceling, setCanceling] = useState<Set<number>>(new Set())

  const closedKey = session && tab === 'CLOSED' ? `closed:${session.userId}:${marketId ?? 'all'}` : null
  const closed = usePolling(
    closedKey,
    (signal) => api.myOrders({ status: 'CLOSED', ...(marketId != null ? { marketId } : {}), limit: 50 }, signal),
    3000,
    accountVersion,
  )

  // Forget cancel requests once their orders have left the active list
  useEffect(() => {
    if (!active.data || canceling.size === 0) return
    const still = new Set(active.data.map((o) => o.orderId))
    const next = new Set([...canceling].filter((id) => still.has(id)))
    if (next.size !== canceling.size) setCanceling(next)
  }, [active.data, canceling])

  const cancel = async (order: Order) => {
    setCanceling((set) => new Set(set).add(order.orderId))
    try {
      await api.cancelOrder(order.orderId)
    } catch (error) {
      if (!(error instanceof ApiError && error.type === '/problems/order-closed')) {
        toast(`Could not cancel order ${order.orderId}: ${describeError(error)}`)
      }
      setCanceling((set) => {
        const next = new Set(set)
        next.delete(order.orderId)
        return next
      })
    } finally {
      accountChanged()
    }
  }

  const poll = tab === 'ACTIVE' ? active : closed
  const orders = poll.data
  const activeCount = active.data?.length

  return (
    <section className="pane orders" aria-label={title}>
      <header className="pane-head">
        <h2>{title}</h2>
        <div className="tabs" role="tablist" aria-label="Which orders">
          <button type="button" role="tab" aria-selected={tab === 'ACTIVE'} onClick={() => setTab('ACTIVE')}>
            Open{activeCount ? <span className="tab-count num">{activeCount}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'CLOSED'} onClick={() => setTab('CLOSED')}>
            Closed
          </button>
        </div>
      </header>
      <div className="table-scroll">
        {orders && orders.length > 0 ? (
          <OrdersTable orders={orders} showMarket={showMarket} canceling={canceling} onCancel={cancel} />
        ) : (
          <div className="orders-empty">
            {orders === undefined
              ? poll.error
                ? describeError(poll.error)
                : 'Loading…'
              : tab === 'ACTIVE'
                ? emptyActive
                : 'No closed orders yet.'}
          </div>
        )}
      </div>
    </section>
  )
}

function OrdersTable({
  orders,
  showMarket,
  canceling,
  onCancel,
}: {
  orders: Order[]
  showMarket: boolean
  canceling: Set<number>
  onCancel: (order: Order) => void
}) {
  const { byId } = useMarkets()
  return (
    <table className="data-table orders-table">
      <thead>
        <tr>
          <th scope="col" className="col-time">Placed</th>
          {showMarket && <th scope="col">Item</th>}
          <th scope="col">Side</th>
          <th scope="col" className="r">Price</th>
          <th scope="col" className="r">Filled</th>
          <th scope="col" className="col-tif">TIF</th>
          <th scope="col">Status</th>
          <th scope="col" className="r">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => {
          const market = byId.get(order.marketId)
          const isCanceling = canceling.has(order.orderId)
          return (
            <tr key={order.orderId}>
              <td className="num muted col-time">{formatTimestamp(order.createdAt)}</td>
              {showMarket && (
                <td>
                  <Link to={`/markets/${order.marketId}`}>{market?.name ?? `Market ${order.marketId}`}</Link>
                </td>
              )}
              <td className={order.side === 'BUY' ? 'up' : 'down'}>{order.side === 'BUY' ? 'Buy' : 'Sell'}</td>
              <td className="num r">{formatInt(order.price)}</td>
              <td className="num r">
                <span className="fill">
                  <span className="fill-text">
                    {formatInt(order.filled)}
                    <span className="muted"> / {formatInt(order.quantity)}</span>
                  </span>
                  <span className="fill-bar" aria-hidden="true">
                    <span style={{ width: `${(order.filled / order.quantity) * 100}%` }} />
                  </span>
                </span>
              </td>
              <td className="muted col-tif">{order.timeInForce}</td>
              <td className={`status status-${order.status.toLowerCase()}`}>
                {isCanceling && order.status !== 'CLOSED' ? 'Canceling…' : orderStatusLabel(order)}
              </td>
              <td className="r">
                {order.status !== 'CLOSED' && (
                  <button
                    type="button"
                    className="button button-ghost button-small"
                    disabled={isCanceling}
                    onClick={() => onCancel(order)}
                    aria-label={`Cancel order ${order.orderId}`}
                  >
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
