import type { MarketSummary, Notification } from '../api/types'
import { formatInt } from './format'

export interface NotificationView {
  text: string
  tone: 'buy' | 'sell' | 'neutral'
  marketId: number | undefined
}

/** Builds the sentence for a notification from its `kind` and `params`. */
export function describeNotification(
  notification: Notification,
  byKey: Map<string, MarketSummary>,
): NotificationView {
  const params = notification.params
  const marketKey = typeof params.marketKey === 'string' ? params.marketKey : undefined
  const market = marketKey ? byKey.get(marketKey) : undefined
  const item = market?.name ?? (marketKey ? itemNameFromKey(marketKey) : 'items')
  const quantity = formatInt(numberParam(params.quantity))
  const price = formatInt(numberParam(params.price))

  switch (notification.kind) {
    case 'ITEM_SOLD':
      return {
        text: `Sold ${quantity} ${item} at ${price}, received ${formatInt(numberParam(params.proceeds))}`,
        tone: 'sell',
        marketId: market?.marketId,
      }
    case 'ITEM_BOUGHT':
      return { text: `Bought ${quantity} ${item} at ${price}`, tone: 'buy', marketId: market?.marketId }
    default:
      return { text: humanize(notification.kind), tone: 'neutral', marketId: market?.marketId }
  }
}

function numberParam(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** `idle-mine/iron_ore` -> `Iron ore`, for markets the list does not know (yet). */
function itemNameFromKey(marketKey: string): string {
  const defId = marketKey.split('/').pop() ?? marketKey
  return humanize(defId)
}

function humanize(code: string): string {
  const words = code.toLowerCase().replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
