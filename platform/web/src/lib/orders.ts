import type { Order, TimeInForce } from '../api/types'

export const TIME_IN_FORCE: { value: TimeInForce; label: string; explanation: string }[] = [
  { value: 'GTC', label: 'GTC', explanation: 'Good till canceled: whatever does not fill now waits in the book.' },
  { value: 'IOC', label: 'IOC', explanation: 'Immediate or cancel: fill what is possible now, cancel the rest.' },
  { value: 'FOK', label: 'FOK', explanation: 'Fill or kill: fill the whole quantity now, or nothing at all.' },
]

export function orderStatusLabel(order: Order): string {
  if (order.status === 'PENDING') return 'Pending'
  if (order.status === 'OPEN') return order.filled > 0 ? 'Partially filled' : 'Open'
  switch (order.closeReason) {
    case 'FILLED':
      return 'Filled'
    case 'CANCELED':
      return order.filled > 0 ? 'Canceled, part filled' : 'Canceled'
    case 'IOC_UNFILLED':
      return order.filled > 0 ? 'Rest canceled (IOC)' : 'Not filled (IOC)'
    case 'FOK_UNFILLED':
      return 'Not filled (FOK)'
    case 'TARGET_UNAVAILABLE':
      return 'Listing unavailable'
    case 'TARGET_PRICE_MISMATCH':
      return 'Price changed'
    default:
      return 'Closed'
  }
}

export function isActive(order: Order): boolean {
  return order.status !== 'CLOSED'
}
