// Shapes of docs/api.md. Credits and quantities are integers, timestamps are ISO-8601 strings in UTC.

export type Side = 'BUY' | 'SELL'
export type TimeInForce = 'GTC' | 'IOC' | 'FOK'
export type OrderStatus = 'PENDING' | 'OPEN' | 'CLOSED'
export type CloseReason =
  | 'FILLED'
  | 'CANCELED'
  | 'IOC_UNFILLED'
  | 'FOK_UNFILLED'
  | 'TARGET_UNAVAILABLE'
  | 'TARGET_PRICE_MISMATCH'
export type CandleInterval = '1m' | '5m' | '1h'

export interface GuestSession {
  token: string
  userId: number
  displayName: string
  expiresAt: string
}

export interface Me {
  userId: number
  displayName: string
}

export interface Wallet {
  available: number
  reserved: number
}

export interface InventoryItem {
  marketId: number
  gameId: string
  defId: string
  name: string
  available: number
  reserved: number
}

export interface Inventory {
  fungible: InventoryItem[]
  unique: unknown[]
}

export interface Order {
  orderId: number
  clientOrderId: string | null
  marketId: number
  side: Side
  price: number
  quantity: number
  filled: number
  timeInForce: TimeInForce
  assetId: number | null
  targetOrderId: number | null
  status: OrderStatus
  closeReason: CloseReason | null
  createdAt: string
}

export type OrderListStatus = 'ACTIVE' | 'CLOSED' | 'ALL'

export interface PlaceOrderRequest {
  clientOrderId: string
  marketId: number
  side: Side
  price: number
  quantity: number
  timeInForce: TimeInForce
}

export interface PlaceOrderResponse {
  orderId: number
  status: OrderStatus
}

export interface Notification {
  notificationId: number
  kind: string
  read: boolean
  createdAt: string
  params: Record<string, unknown>
}

export interface Notifications {
  unread: number
  items: Notification[]
}

export interface MarketSummary {
  marketId: number
  marketKey: string
  gameId: string
  gameName: string
  defId: string
  name: string
  kind: string
  lastPrice: number | null
  open24h: number | null
  volume24h: number
  trades24h: number
  bestBid: number | null
  bestAsk: number | null
}

export interface BookLevel {
  price: number
  quantity: number
  orders: number
}

export interface OrderBook {
  marketId: number
  marketKey: string
  sequence: number
  asks: BookLevel[]
  bids: BookLevel[]
}

export interface Trade {
  tradeId: string
  price: number
  quantity: number
  takerSide: Side
  occurredAt: string
}

export interface Candle {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  vwap: number
}

/** RFC 9457 Problem Details as core returns them. */
export interface Problem {
  type: string
  title: string
  status: number
  detail?: string
}
