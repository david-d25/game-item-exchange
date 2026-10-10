import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ApiError, NetworkError, describeError } from '../api/client'
import { api } from '../api/endpoints'
import type { Inventory, MarketSummary, PlaceOrderRequest, PlaceOrderResponse, Side, TimeInForce } from '../api/types'
import { AlertIcon, CheckIcon } from '../components/icons'
import { formatInt, parseInteger } from '../lib/format'
import { newClientOrderId } from '../lib/ids'
import { TIME_IN_FORCE } from '../lib/orders'
import { useSession } from '../state/session'

const MAX_VALUE = 1_000_000_000
const FEE_PERCENT = 5

interface Props {
  market: MarketSummary
  inventory: Inventory | undefined
  /** Set when a book level is clicked; the nonce lets the same price be picked twice. */
  picked: { price: number; nonce: number } | null
  bestBid: number | null
  bestAsk: number | null
}

type Feedback = { kind: 'ok' | 'error'; text: string } | null

export function OrderForm({ market, inventory, picked, bestBid, bestAsk }: Props) {
  const { wallet, accountChanged } = useSession()
  const [side, setSide] = useState<Side>('BUY')
  const [priceText, setPriceText] = useState('')
  const [quantityText, setQuantityText] = useState('')
  const [timeInForce, setTimeInForce] = useState<TimeInForce>('GTC')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  // One clientOrderId per intent: kept while the same order is retried after a network failure
  const intent = useRef<{ id: string; fingerprint: string } | null>(null)
  const ids = { price: useId(), quantity: useId(), tif: useId(), feedback: useId() }

  // Start from the price someone would most likely trade at
  const seededFor = useRef<number | null>(null)
  useEffect(() => {
    if (seededFor.current === market.marketId) return
    const start = market.lastPrice ?? bestAsk ?? bestBid
    if (start == null) return
    seededFor.current = market.marketId
    setPriceText(String(start))
  }, [market.marketId, market.lastPrice, bestAsk, bestBid])

  useEffect(() => {
    if (!picked) return
    setPriceText(String(picked.price))
    setFeedback(null)
  }, [picked])

  const price = parseInteger(priceText)
  const quantity = parseInteger(quantityText)
  const priceValid = price != null && price >= 1 && price <= MAX_VALUE
  const quantityValid = quantity != null && quantity >= 1 && quantity <= MAX_VALUE
  const total = priceValid && quantityValid ? price * quantity : null
  const item = inventory?.fungible.find((i) => i.marketId === market.marketId)
  const itemsAvailable = inventory ? (item?.available ?? 0) : undefined

  let problem: string | null = null
  if (priceText && !priceValid) problem = `Price must be a whole number from 1 to ${formatInt(MAX_VALUE)}.`
  else if (quantityText && !quantityValid) problem = `Quantity must be a whole number from 1 to ${formatInt(MAX_VALUE)}.`
  else if (side === 'BUY' && total != null && wallet && total > wallet.available) {
    problem = `Not enough credits: this order needs ${formatInt(total)}, you have ${formatInt(wallet.available)}.`
  } else if (side === 'SELL' && quantity != null && itemsAvailable !== undefined && quantity > itemsAvailable) {
    problem = `Not enough ${market.name}: you have ${formatInt(itemsAvailable)}.`
  }
  const canSubmit = priceValid && quantityValid && !problem && !submitting

  const fee = total != null ? Math.floor((total * FEE_PERCENT) / 100) : null
  const max =
    side === 'BUY'
      ? wallet && priceValid
        ? Math.min(MAX_VALUE, Math.floor(wallet.available / price))
        : null
      : (itemsAvailable ?? null)

  const edit = (apply: () => void) => {
    apply()
    setFeedback(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit || price == null || quantity == null) return
    const fields = { marketId: market.marketId, side, price, quantity, timeInForce }
    const fingerprint = JSON.stringify(fields)
    if (intent.current?.fingerprint !== fingerprint) {
      intent.current = { id: newClientOrderId(), fingerprint }
    }
    const request: PlaceOrderRequest = { clientOrderId: intent.current.id, ...fields }

    setSubmitting(true)
    setFeedback(null)
    try {
      await placeWithRetry(request)
      intent.current = null
      const verb = side === 'BUY' ? 'Buy' : 'Sell'
      setFeedback({ kind: 'ok', text: `${verb} order placed: ${formatInt(quantity)} ${market.name} at ${formatInt(price)}.` })
      accountChanged()
      // The matcher usually answers within a few hundred milliseconds: show the result without waiting for a poll
      window.setTimeout(accountChanged, 700)
    } catch (error) {
      if (isRetryable(error)) {
        // Same order on the next click: the exchange recognizes the id and will not place it twice
        setFeedback({
          kind: 'error',
          text: 'The exchange did not answer. Place the order again: it is sent with the same id and cannot be placed twice.',
        })
      } else {
        intent.current = null
        setFeedback({ kind: 'error', text: describeError(error) })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const tif = TIME_IN_FORCE.find((t) => t.value === timeInForce)!

  return (
    <form className={`order-form side-${side.toLowerCase()}`} onSubmit={submit} noValidate aria-describedby={ids.feedback}>
      <div className="side-switch" role="radiogroup" aria-label="Side">
        {(['BUY', 'SELL'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            className={side === s ? `is-active ${s === 'BUY' ? 'buy' : 'sell'}` : undefined}
            onClick={() => edit(() => setSide(s))}
          >
            {s === 'BUY' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor={ids.price}>Limit price</label>
        <div className="input-wrap">
          <input
            id={ids.price}
            inputMode="numeric"
            autoComplete="off"
            value={priceText}
            onChange={(e) => edit(() => setPriceText(e.target.value))}
            aria-invalid={priceText !== '' && !priceValid}
          />
          <span className="input-unit">credits</span>
        </div>
        <div className="field-shortcuts">
          <button type="button" className="link-button" disabled={bestBid == null}
            onClick={() => bestBid != null && edit(() => setPriceText(String(bestBid)))}>
            Bid <span className="num">{formatInt(bestBid)}</span>
          </button>
          <button type="button" className="link-button" disabled={bestAsk == null}
            onClick={() => bestAsk != null && edit(() => setPriceText(String(bestAsk)))}>
            Ask <span className="num">{formatInt(bestAsk)}</span>
          </button>
        </div>
      </div>

      <div className="field">
        <label htmlFor={ids.quantity}>Quantity</label>
        <div className="input-wrap">
          <input
            id={ids.quantity}
            inputMode="numeric"
            autoComplete="off"
            placeholder="0"
            value={quantityText}
            onChange={(e) => edit(() => setQuantityText(e.target.value))}
            aria-invalid={quantityText !== '' && !quantityValid}
          />
          <span className="input-unit">{market.name}</span>
        </div>
        <div className="field-shortcuts">
          <span className="muted">
            Available{' '}
            <span className="num">
              {side === 'BUY'
                ? wallet ? `${formatInt(wallet.available)} credits` : '—'
                : itemsAvailable !== undefined ? `${formatInt(itemsAvailable)} ${market.name}` : '—'}
            </span>
          </span>
          <button type="button" className="link-button" disabled={!max}
            onClick={() => max && edit(() => setQuantityText(String(max)))}>
            Max
          </button>
        </div>
      </div>

      <fieldset className="field">
        <legend id={ids.tif}>Time in force</legend>
        <div className="segmented" role="radiogroup" aria-labelledby={ids.tif}>
          {TIME_IN_FORCE.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={timeInForce === t.value}
              className={timeInForce === t.value ? 'is-active' : undefined}
              onClick={() => edit(() => setTimeInForce(t.value))}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="field-note">{tif.explanation}</p>
      </fieldset>

      <dl className="order-summary">
        <div>
          <dt>Total</dt>
          <dd className="num">{total != null ? `${formatInt(total)} credits` : '—'}</dd>
        </div>
        {side === 'BUY' ? (
          <div>
            <dt>Reserved now</dt>
            <dd className="num muted">{total != null ? formatInt(total) : '—'}</dd>
          </div>
        ) : (
          <div>
            <dt>You receive at least</dt>
            <dd className="num muted">{total != null && fee != null ? formatInt(total - fee) : '—'}</dd>
          </div>
        )}
      </dl>
      <p className="field-note">
        {side === 'BUY'
          ? 'If it trades below your price, the difference comes back at once.'
          : `Sellers pay a ${FEE_PERCENT}% fee on the trade value.`}
      </p>

      <button type="submit" className={`button button-block button-${side === 'BUY' ? 'buy' : 'sell'}`} disabled={!canSubmit}>
        {submitting ? 'Placing order…' : `${side === 'BUY' ? 'Buy' : 'Sell'} ${market.name}`}
      </button>

      <div id={ids.feedback} className="form-feedback" aria-live="polite">
        {problem && (
          <p className="message">
            <AlertIcon /> {problem}
          </p>
        )}
        {!problem && feedback && (
          <p className={feedback.kind === 'ok' ? 'message is-ok' : 'message'}>
            {feedback.kind === 'ok' ? <CheckIcon /> : <AlertIcon />} {feedback.text}
          </p>
        )}
      </div>
    </form>
  )
}

function isRetryable(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof ApiError && error.transient)
}

/** Retries network failures and gateway hiccups with the same body, so the same clientOrderId. */
async function placeWithRetry(request: PlaceOrderRequest): Promise<PlaceOrderResponse> {
  const delays = [400, 1200]
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.placeOrder(request)
    } catch (error) {
      const delay = delays[attempt]
      if (!isRetryable(error) || delay === undefined) throw error
      await new Promise((resolve) => window.setTimeout(resolve, delay))
    }
  }
}
