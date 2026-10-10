import { request } from './client'
import type {
  Candle,
  CandleInterval,
  GuestSession,
  Inventory,
  MarketSummary,
  Me,
  Notifications,
  Order,
  OrderBook,
  OrderListStatus,
  PlaceOrderRequest,
  PlaceOrderResponse,
  Trade,
  Wallet,
} from './types'

type Signal = AbortSignal | undefined

const withSignal = (signal: Signal) => (signal ? { signal } : {})

export const api = {
  createGuest: () => request<GuestSession>('POST', '/auth/guest'),

  me: (signal?: Signal) => request<Me>('GET', '/me', withSignal(signal)),
  wallet: (signal?: Signal) => request<Wallet>('GET', '/me/wallet', withSignal(signal)),
  inventory: (signal?: Signal) => request<Inventory>('GET', '/me/inventory', withSignal(signal)),
  myOrders: (params: { status: OrderListStatus; marketId?: number; limit?: number }, signal?: Signal) =>
    request<Order[]>('GET', '/me/orders', { query: params, ...withSignal(signal) }),
  notifications: (limit: number, signal?: Signal) =>
    request<Notifications>('GET', '/me/notifications', { query: { limit }, ...withSignal(signal) }),
  markNotificationsRead: () => request<void>('POST', '/me/notifications/read'),

  placeOrder: (order: PlaceOrderRequest) => request<PlaceOrderResponse>('POST', '/orders', { body: order }),
  cancelOrder: (orderId: number) => request<void>('POST', `/orders/${orderId}/cancel`),

  markets: (signal?: Signal) => request<MarketSummary[]>('GET', '/markets', withSignal(signal)),
  book: (marketId: number, depth: number, signal?: Signal) =>
    request<OrderBook>('GET', `/markets/${marketId}/book`, { query: { depth }, ...withSignal(signal) }),
  trades: (marketId: number, limit: number, signal?: Signal) =>
    request<Trade[]>('GET', `/markets/${marketId}/trades`, { query: { limit }, ...withSignal(signal) }),
  candles: (marketId: number, interval: CandleInterval, limit: number, signal?: Signal) =>
    request<Candle[]>('GET', `/markets/${marketId}/candles`, { query: { interval, limit }, ...withSignal(signal) }),
}
