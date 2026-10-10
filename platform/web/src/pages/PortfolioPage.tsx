import { Link } from 'react-router'
import { describeError } from '../api/client'
import { api } from '../api/endpoints'
import { GuestCta } from '../components/GuestCta'
import { ItemGlyph } from '../components/ItemGlyph'
import { OrdersPanel } from '../components/OrdersPanel'
import { usePolling } from '../hooks/usePolling'
import { formatInt } from '../lib/format'
import { useMarkets } from '../state/markets'
import { useSession } from '../state/session'

export function PortfolioPage() {
  const { session } = useSession()
  if (!session) {
    return (
      <div className="page portfolio-page">
        <div className="page-head">
          <h1>Portfolio</h1>
        </div>
        <div className="pane portfolio-cta">
          <GuestCta title="Nothing here yet">
            Your credits, items and orders appear here once you have a guest account: 50{'\u2009'}000 play credits and
            a starter pack of every item, no sign-up.
          </GuestCta>
        </div>
      </div>
    )
  }
  return <Portfolio userId={session.userId} displayName={session.displayName} />
}

function Portfolio({ userId, displayName }: { userId: number; displayName: string }) {
  const { wallet, accountVersion } = useSession()
  const { byId } = useMarkets()
  const inventory = usePolling(`inventory:${userId}`, (s) => api.inventory(s), 3000, accountVersion)
  const active = usePolling(`active:${userId}:all`, (s) => api.myOrders({ status: 'ACTIVE', limit: 200 }, s), 3000,
    accountVersion)

  const items = inventory.data?.fungible ?? []
  const valued = items.map((item) => {
    const lastPrice = byId.get(item.marketId)?.lastPrice ?? null
    const quantity = item.available + item.reserved
    return { item, lastPrice, value: lastPrice != null ? lastPrice * quantity : null }
  })
  const itemsValue = valued.reduce((sum, v) => sum + (v.value ?? 0), 0)
  const credits = wallet ? wallet.available + wallet.reserved : null

  return (
    <div className="page portfolio-page">
      <div className="page-head">
        <h1>Portfolio</h1>
        <p className="muted">{displayName}</p>
      </div>

      <section className="pane summary-strip" aria-label="Balances">
        <dl>
          <div>
            <dt>Available credits</dt>
            <dd className="num">{formatInt(wallet?.available)}</dd>
          </div>
          <div>
            <dt>Reserved by open orders</dt>
            <dd className="num">{formatInt(wallet?.reserved)}</dd>
          </div>
          <div>
            <dt>Items at last price</dt>
            <dd className="num">{inventory.data ? formatInt(itemsValue) : '—'}</dd>
          </div>
          <div className="summary-total">
            <dt>Total value</dt>
            <dd className="num">{credits != null && inventory.data ? formatInt(credits + itemsValue) : '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="pane inventory" aria-label="Items">
        <header className="pane-head">
          <h2>Items</h2>
          <span className="pane-hint">Reserved items are locked by your open sell orders</span>
        </header>
        <div className="table-scroll">
          {inventory.data && items.length > 0 ? (
            <table className="data-table inventory-table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="r">Available</th>
                  <th scope="col" className="r">Reserved</th>
                  <th scope="col" className="r col-optional">Last price</th>
                  <th scope="col" className="r">Value</th>
                  <th scope="col" className="r">
                    <span className="visually-hidden">Trade</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {valued.map(({ item, lastPrice, value }) => (
                  <tr key={item.marketId}>
                    <td>
                      <Link to={`/markets/${item.marketId}`} className="item-cell">
                        <ItemGlyph defId={item.defId} name={item.name} size={24} />
                        {item.name}
                      </Link>
                    </td>
                    <td className="num r">{formatInt(item.available)}</td>
                    <td className="num r muted">{formatInt(item.reserved)}</td>
                    <td className="num r col-optional">{formatInt(lastPrice)}</td>
                    <td className="num r">{formatInt(value)}</td>
                    <td className="r">
                      <Link to={`/markets/${item.marketId}`} className="button button-ghost button-small">
                        Trade
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="orders-empty">
              {inventory.data
                ? 'No items. Buy some on any market.'
                : inventory.error
                  ? describeError(inventory.error)
                  : 'Loading…'}
            </div>
          )}
        </div>
      </section>

      <OrdersPanel
        title="Orders"
        active={active}
        showMarket
        emptyActive={
          <>
            No open orders. <Link to="/">Pick a market</Link> to place one.
          </>
        }
      />
    </div>
  )
}
