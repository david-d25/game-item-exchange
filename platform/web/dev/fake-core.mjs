// Fake core for developing the web app without Postgres, Kafka and the JVM.
//
//   npm run fake            # listens on http://localhost:8080
//   PORT=9090 npm run fake
//
// Implements the public part of docs/api.md in memory: guests, wallet, inventory, orders, notifications
// and the three demo markets. Bots quote around a drifting fair price and take liquidity now and then,
// so the book and the tape keep moving. A small price-time matcher runs inside this process.
// Good enough for development and screenshots, not a model of the real system.

import http from 'node:http'
import { randomBytes } from 'node:crypto'

const PORT = Number(process.env.PORT ?? 8080)
const HISTORY_DAYS = 6
const FEE_PERCENT = 5

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic randomness, so two runs look alike

let seed = Number(process.env.SEED ?? 20261010) >>> 0
function random() {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (min, max) => min + Math.floor(random() * (max - min + 1))
const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())

// ---------------------------------------------------------------------------------------------------------------------
// Catalog and state

const GAME = { gameId: 'idle-mine', gameName: 'Idle Mine' }

const markets = [
    { marketId: 1, defId: 'iron_ore', name: 'Iron ore', base: 300, step: 1, qty: [4, 90], starter: 40 },
    { marketId: 2, defId: 'coal', name: 'Coal', base: 120, step: 1, qty: [10, 240], starter: 120 },
    { marketId: 3, defId: 'crystal', name: 'Crystal', base: 2500, step: 5, qty: [1, 9], starter: 6 },
].map((m) => ({
    ...m,
    ...GAME,
    marketKey: `${GAME.gameId}/${m.defId}`,
    kind: 'FUNGIBLE',
    fair: m.base,
    trades: [], // oldest first
    bids: [], // resting orders, best first, then by time
    asks: [],
    sequence: 0,
    tradeCounter: 1000,
}))
const marketById = new Map(markets.map((m) => [m.marketId, m]))

const users = new Map() // userId -> user
const usersByToken = new Map()
const orders = new Map() // orderId -> order
let nextUserId = 41
let nextOrderId = 9000
let nextNotificationId = 1
let orderSeq = 0

const BOT = { userId: 3, displayName: 'maker-1', bot: true }
const TAKER = { userId: 4, displayName: 'taker-1', bot: true }
users.set(BOT.userId, BOT)
users.set(TAKER.userId, TAKER)

// ---------------------------------------------------------------------------------------------------------------------
// History: a few days of trades so every candle interval has something to draw

function seedHistory() {
    const now = Date.now()
    for (const m of markets) {
        let price = m.base * (0.93 + random() * 0.1)
        let t = now - HISTORY_DAYS * 86_400_000
        const drift = (random() - 0.45) * 0.000004
        while (t < now - 5_000) {
            t += between(2_000, 14_000)
            // Mean-reverting walk with a slow daily swing
            const swing = Math.sin((t / 86_400_000) * 2 * Math.PI + m.marketId) * 0.00003
            price *= Math.exp(gaussian() * 0.0012 + swing + drift + (m.base - price) / m.base * 0.0006)
            const p = roundToStep(price, m.step)
            m.trades.push({
                tradeId: `${m.tradeCounter++}-0`,
                price: p,
                quantity: between(m.qty[0], m.qty[1]),
                takerSide: random() < 0.5 ? 'BUY' : 'SELL',
                occurredAt: t,
            })
        }
        m.fair = price
    }
}

function roundToStep(price, step) {
    return Math.max(step, Math.round(price / step) * step)
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching

function bookSide(m, side) {
    return side === 'BUY' ? m.bids : m.asks
}

function insertResting(m, order) {
    const list = bookSide(m, order.side)
    const better = order.side === 'BUY' ? (a, b) => a.price > b.price : (a, b) => a.price < b.price
    let i = 0
    while (i < list.length && (better(list[i], order) || list[i].price === order.price)) i++
    list.splice(i, 0, order)
    m.sequence++
}

function removeResting(m, order) {
    const list = bookSide(m, order.side)
    const i = list.indexOf(order)
    if (i >= 0) {
        list.splice(i, 1)
        m.sequence++
    }
}

function crosses(taker, maker) {
    return taker.side === 'BUY' ? maker.price <= taker.price : maker.price >= taker.price
}

function match(order) {
    const m = marketById.get(order.marketId)
    const opposite = order.side === 'BUY' ? m.asks : m.bids
    if (order.timeInForce === 'FOK') {
        let available = 0
        for (const maker of opposite) {
            if (!crosses(order, maker) || available >= order.quantity) break
            available += maker.quantity - maker.filled
        }
        if (available < order.quantity) {
            close(order, 'FOK_UNFILLED')
            return
        }
    }
    while (order.filled < order.quantity && opposite.length > 0 && crosses(order, opposite[0])) {
        const maker = opposite[0]
        const quantity = Math.min(order.quantity - order.filled, maker.quantity - maker.filled)
        trade(m, order, maker, quantity)
        if (maker.filled === maker.quantity) {
            opposite.shift()
            m.sequence++
            close(maker, 'FILLED')
        }
    }
    if (order.filled === order.quantity) {
        close(order, 'FILLED')
    } else if (order.timeInForce === 'GTC') {
        order.status = 'OPEN'
        insertResting(m, order)
    } else {
        close(order, 'IOC_UNFILLED')
    }
}

function trade(m, taker, maker, quantity) {
    const price = maker.price
    taker.filled += quantity
    maker.filled += quantity
    m.sequence++
    m.trades.push({
        tradeId: `${m.tradeCounter++}-0`,
        price,
        quantity,
        takerSide: taker.side,
        occurredAt: Date.now(),
    })
    const buy = taker.side === 'BUY' ? taker : maker
    const sell = taker.side === 'BUY' ? maker : taker
    const cost = price * quantity
    const fee = Math.floor((cost * FEE_PERCENT) / 100)

    const buyer = users.get(buy.userId)
    if (!buyer.bot) {
        buyer.reserved -= buy.price * quantity
        buyer.available += (buy.price - price) * quantity
        buyer.items[m.marketId].available += quantity
        notify(buyer, 'ITEM_BOUGHT', { marketKey: m.marketKey, quantity, price })
    }
    const seller = users.get(sell.userId)
    if (!seller.bot) {
        seller.items[m.marketId].reserved -= quantity
        seller.available += cost - fee
        notify(seller, 'ITEM_SOLD', { marketKey: m.marketKey, quantity, price, proceeds: cost - fee })
    }
}

function close(order, reason) {
    order.status = 'CLOSED'
    order.closeReason = reason
    const user = users.get(order.userId)
    if (user.bot) {
        orders.delete(order.orderId)
        return
    }
    const rest = order.quantity - order.filled
    if (rest > 0) {
        if (order.side === 'BUY') {
            user.reserved -= order.price * rest
            user.available += order.price * rest
        } else {
            user.items[order.marketId].reserved -= rest
            user.items[order.marketId].available += rest
        }
    }
}

function notify(user, kind, params) {
    user.notifications.unshift({
        notificationId: nextNotificationId++,
        kind,
        read: false,
        createdAt: new Date().toISOString(),
        params,
    })
    user.notifications.length = Math.min(user.notifications.length, 200)
}

function newOrder(user, fields) {
    const order = {
        orderId: nextOrderId++,
        clientOrderId: fields.clientOrderId ?? null,
        userId: user.userId,
        marketId: fields.marketId,
        side: fields.side,
        price: fields.price,
        quantity: fields.quantity,
        filled: 0,
        timeInForce: fields.timeInForce,
        status: 'PENDING',
        closeReason: null,
        createdAt: new Date().toISOString(),
        seq: orderSeq++,
    }
    orders.set(order.orderId, order)
    return order
}

// ---------------------------------------------------------------------------------------------------------------------
// Bots

function botTick(m) {
    // The fair price drifts and is pulled back towards the typical price
    m.fair *= Math.exp(gaussian() * 0.0005 + ((m.base - m.fair) / m.base) * 0.0004)
    const fair = m.fair
    const half = Math.max(m.step, roundToStep(fair * 0.0022, m.step))

    // Makers pull quotes that ended up on the wrong side of the fair price, and some at random
    for (const list of [m.bids, m.asks]) {
        for (const order of [...list]) {
            if (users.get(order.userId) !== BOT) continue
            const stale = order.side === 'BUY' ? order.price > fair - half / 2 : order.price < fair + half / 2
            const far = Math.abs(order.price - fair) / fair > 0.03
            if (stale || far || random() < 0.025) {
                removeResting(m, order)
                close(order, 'CANCELED')
            }
        }
    }

    // ...and keep about a dozen levels on each side
    for (const side of ['BUY', 'SELL']) {
        const list = bookSide(m, side)
        let attempts = 0
        while (levelCount(list) < 13 && attempts++ < 30) {
            const distance = half + between(0, 16) * m.step * (random() < 0.4 ? 1 : 2)
            const price = roundToStep(side === 'BUY' ? fair - distance : fair + distance, m.step)
            const size = between(m.qty[0], m.qty[1]) * (random() < 0.15 ? 3 : 1)
            const order = newOrder(BOT, { marketId: m.marketId, side, price, quantity: size, timeInForce: 'GTC' })
            match(order)
        }
    }

    // Takers cross the spread now and then, leaning towards where the fair price went
    const bestBid = m.bids[0]?.price
    const bestAsk = m.asks[0]?.price
    if (bestBid != null && bestAsk != null && random() < 0.22) {
        const mid = (bestBid + bestAsk) / 2
        const buy = random() < 0.5 + Math.max(-0.3, Math.min(0.3, ((fair - mid) / mid) * 60))
        const side = buy ? 'BUY' : 'SELL'
        const price = buy ? bestAsk + m.step * between(0, 3) : bestBid - m.step * between(0, 3)
        const quantity = between(m.qty[0], Math.ceil(m.qty[1] * 0.4))
        match(newOrder(TAKER, { marketId: m.marketId, side, price, quantity, timeInForce: 'IOC' }))
    }
}

function levelCount(list) {
    let count = 0
    let last = null
    for (const order of list) {
        if (order.price !== last) {
            count++
            last = order.price
        }
    }
    return count
}

// ---------------------------------------------------------------------------------------------------------------------
// Read models

function summary(m) {
    const since = Date.now() - 86_400_000
    let open24h = null
    let volume24h = 0
    let trades24h = 0
    for (let i = m.trades.length - 1; i >= 0 && m.trades[i].occurredAt >= since; i--) {
        open24h = m.trades[i].price
        volume24h += m.trades[i].quantity
        trades24h++
    }
    return {
        marketId: m.marketId,
        marketKey: m.marketKey,
        gameId: m.gameId,
        gameName: m.gameName,
        defId: m.defId,
        name: m.name,
        kind: m.kind,
        lastPrice: m.trades.at(-1)?.price ?? null,
        open24h,
        volume24h,
        trades24h,
        bestBid: m.bids[0]?.price ?? null,
        bestAsk: m.asks[0]?.price ?? null,
    }
}

function levels(list, depth) {
    const result = []
    for (const order of list) {
        const last = result.at(-1)
        if (last && last.price === order.price) {
            last.quantity += order.quantity - order.filled
            last.orders++
        } else {
            if (result.length === depth) break
            result.push({ price: order.price, quantity: order.quantity - order.filled, orders: 1 })
        }
    }
    return result
}

const INTERVALS = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000 }

function candles(m, interval, limit) {
    const size = INTERVALS[interval]
    const from = Math.floor(Date.now() / size) * size - (limit - 1) * size
    let lo = 0
    let hi = m.trades.length
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (m.trades[mid].occurredAt < from) lo = mid + 1
        else hi = mid
    }
    const result = []
    let current = null
    let notional = 0
    for (let i = lo; i < m.trades.length; i++) {
        const t = m.trades[i]
        const bucket = Math.floor(t.occurredAt / size) * size
        if (!current || current.bucket !== bucket) {
            if (current) result.push(finish(current, notional))
            current = { bucket, open: t.price, high: t.price, low: t.price, close: t.price, volume: 0 }
            notional = 0
        }
        current.high = Math.max(current.high, t.price)
        current.low = Math.min(current.low, t.price)
        current.close = t.price
        current.volume += t.quantity
        notional += t.price * t.quantity
    }
    if (current) result.push(finish(current, notional))
    return result
}

function finish(c, notional) {
    return {
        time: new Date(c.bucket).toISOString().replace('.000Z', 'Z'),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        vwap: Math.round((notional / c.volume) * 10) / 10,
    }
}

function orderView(o) {
    return {
        orderId: o.orderId,
        clientOrderId: o.clientOrderId,
        marketId: o.marketId,
        side: o.side,
        price: o.price,
        quantity: o.quantity,
        filled: o.filled,
        timeInForce: o.timeInForce,
        assetId: null,
        targetOrderId: null,
        status: o.status,
        closeReason: o.closeReason,
        createdAt: o.createdAt,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP

class Problem extends Error {
    constructor(status, type, title, detail) {
        super(detail)
        this.status = status
        this.type = type
        this.title = title
        this.detail = detail
    }
}
const invalid = (detail) => new Problem(400, '/problems/invalid-request', 'Invalid request', detail)
const notFound = (what) => new Problem(404, '/problems/not-found', 'Not found', `${what} does not exist`)

function intParam(url, name, min, max, fallback) {
    const raw = url.searchParams.get(name)
    if (raw == null) return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min || value > max) {
        throw invalid(`${name} must be an integer between ${min} and ${max}`)
    }
    return value
}

function requireUser(req) {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    const user = token ? usersByToken.get(token) : null
    if (!user) throw new Problem(401, '/problems/unauthorized', 'Unauthorized', 'A valid token is required')
    return user
}

function market(id) {
    const m = marketById.get(Number(id))
    if (!m) throw notFound(`Market ${id}`)
    return m
}

async function readJson(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length === 0) return {}
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
        throw invalid('The body is not valid JSON')
    }
}

function createGuest() {
    const userId = nextUserId++
    const token = `fake.${randomBytes(18).toString('base64url')}`
    const user = {
        userId,
        displayName: `Guest ${userId}`,
        token,
        available: 50_000,
        reserved: 0,
        items: Object.fromEntries(markets.map((m) => [m.marketId, { available: m.starter, reserved: 0 }])),
        notifications: [],
        clientOrderIds: new Map(),
    }
    users.set(userId, user)
    usersByToken.set(token, user)
    return user
}

function placeOrder(user, body) {
    const { clientOrderId, marketId, side, price, quantity } = body
    const timeInForce = body.timeInForce ?? 'GTC'
    if (typeof clientOrderId !== 'string' || clientOrderId.length < 1 || clientOrderId.length > 64) {
        throw invalid('clientOrderId must be 1 to 64 characters')
    }
    if (side !== 'BUY' && side !== 'SELL') throw invalid('side must be BUY or SELL')
    for (const [name, value] of [['price', price], ['quantity', quantity]]) {
        if (!Number.isInteger(value) || value < 1 || value > 1_000_000_000) {
            throw invalid(`${name} must be an integer between 1 and 1000000000`)
        }
    }
    if (!['GTC', 'IOC', 'FOK'].includes(timeInForce)) throw invalid('timeInForce must be GTC, IOC or FOK')
    const m = market(marketId)

    const previousId = user.clientOrderIds.get(clientOrderId)
    if (previousId != null) {
        const previous = orders.get(previousId)
        const same = previous.marketId === m.marketId && previous.side === side && previous.price === price &&
            previous.quantity === quantity && previous.timeInForce === timeInForce
        if (!same) {
            throw new Problem(409, '/problems/client-order-id-reused', 'Client order id reused',
                `clientOrderId ${clientOrderId} was already used for a different order`)
        }
        return [200, { orderId: previous.orderId, status: previous.status }]
    }

    if (side === 'BUY') {
        const cost = price * quantity
        if (cost > user.available) {
            throw new Problem(422, '/problems/insufficient-funds', 'Insufficient funds',
                `The order requires ${cost} credits, ${user.available} available`)
        }
        user.available -= cost
        user.reserved += cost
    } else {
        const items = user.items[m.marketId]
        if (quantity > items.available) {
            throw new Problem(422, '/problems/insufficient-items', 'Insufficient items',
                `The order requires ${quantity} ${m.name}, ${items.available} available`)
        }
        items.available -= quantity
        items.reserved += quantity
    }

    const order = newOrder(user, { clientOrderId, marketId: m.marketId, side, price, quantity, timeInForce })
    user.clientOrderIds.set(clientOrderId, order.orderId)
    // The matcher picks it up "in well under a second"
    setTimeout(() => {
        if (order.status === 'PENDING') match(order)
    }, between(120, 450))
    return [202, { orderId: order.orderId, status: order.status }]
}

function cancelOrder(user, orderId) {
    const order = orders.get(orderId)
    if (!order || order.userId !== user.userId) throw notFound(`Order ${orderId}`)
    if (order.status === 'CLOSED') {
        throw new Problem(409, '/problems/order-closed', 'Order closed', `Order ${orderId} is already closed`)
    }
    setTimeout(() => {
        if (order.status === 'CLOSED') return
        if (order.status === 'OPEN') removeResting(marketById.get(order.marketId), order)
        close(order, 'CANCELED')
    }, between(100, 300))
}

const routes = [
    ['POST', /^\/api\/v1\/auth\/guest$/, () => {
        const user = createGuest()
        const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()
        return [201, { token: user.token, userId: user.userId, displayName: user.displayName, expiresAt }]
    }],
    ['GET', /^\/api\/v1\/me$/, (req) => {
        const user = requireUser(req)
        return [200, { userId: user.userId, displayName: user.displayName }]
    }],
    ['GET', /^\/api\/v1\/me\/wallet$/, (req) => {
        const user = requireUser(req)
        return [200, { available: user.available, reserved: user.reserved }]
    }],
    ['GET', /^\/api\/v1\/me\/inventory$/, (req) => {
        const user = requireUser(req)
        const fungible = markets.map((m) => ({
            marketId: m.marketId,
            gameId: m.gameId,
            defId: m.defId,
            name: m.name,
            available: user.items[m.marketId].available,
            reserved: user.items[m.marketId].reserved,
        })).filter((i) => i.available + i.reserved > 0)
        return [200, { fungible, unique: [] }]
    }],
    ['GET', /^\/api\/v1\/me\/orders$/, (req, url) => {
        const user = requireUser(req)
        const status = url.searchParams.get('status') ?? 'ACTIVE'
        if (!['ACTIVE', 'CLOSED', 'ALL'].includes(status)) throw invalid('status must be ACTIVE, CLOSED or ALL')
        const marketId = url.searchParams.has('marketId') ? intParam(url, 'marketId', 1, 1e12, null) : null
        const limit = intParam(url, 'limit', 1, 200, 50)
        const list = [...orders.values()]
            .filter((o) => o.userId === user.userId)
            .filter((o) => marketId == null || o.marketId === marketId)
            .filter((o) => status === 'ALL' || (status === 'CLOSED') === (o.status === 'CLOSED'))
            .sort((a, b) => b.orderId - a.orderId)
            .slice(0, limit)
            .map(orderView)
        return [200, list]
    }],
    ['GET', /^\/api\/v1\/me\/notifications$/, (req, url) => {
        const user = requireUser(req)
        const limit = intParam(url, 'limit', 1, 200, 20)
        return [200, {
            unread: user.notifications.filter((n) => !n.read).length,
            items: user.notifications.slice(0, limit),
        }]
    }],
    ['POST', /^\/api\/v1\/me\/notifications\/read$/, (req) => {
        const user = requireUser(req)
        for (const n of user.notifications) n.read = true
        return [204, null]
    }],
    ['POST', /^\/api\/v1\/orders$/, async (req) => placeOrder(requireUser(req), await readJson(req))],
    ['GET', /^\/api\/v1\/orders\/(\d+)$/, (req, _url, [id]) => {
        const user = requireUser(req)
        const order = orders.get(Number(id))
        if (!order || order.userId !== user.userId) throw notFound(`Order ${id}`)
        return [200, orderView(order)]
    }],
    ['POST', /^\/api\/v1\/orders\/(\d+)\/cancel$/, (req, _url, [id]) => {
        cancelOrder(requireUser(req), Number(id))
        return [202, null]
    }],
    ['GET', /^\/api\/v1\/markets$/, () => [200, markets.map(summary)]],
    ['GET', /^\/api\/v1\/markets\/(\d+)$/, (_req, _url, [id]) => [200, summary(market(id))]],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/book$/, (_req, url, [id]) => {
        const m = market(id)
        const depth = intParam(url, 'depth', 1, 500, 50)
        return [200, {
            marketId: m.marketId,
            marketKey: m.marketKey,
            sequence: m.sequence,
            asks: levels(m.asks, depth),
            bids: levels(m.bids, depth),
        }]
    }],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/trades$/, (_req, url, [id]) => {
        const m = market(id)
        const limit = intParam(url, 'limit', 1, 200, 50)
        return [200, m.trades.slice(-limit).reverse().map((t) => ({
            ...t,
            occurredAt: new Date(t.occurredAt).toISOString(),
        }))]
    }],
    ['GET', /^\/api\/v1\/markets\/(\d+)\/candles$/, (_req, url, [id]) => {
        const m = market(id)
        const interval = url.searchParams.get('interval') ?? '1m'
        if (!(interval in INTERVALS)) throw invalid('interval must be 1m, 5m or 1h')
        const limit = intParam(url, 'limit', 1, 500, 120)
        return [200, candles(m, interval, limit)]
    }],
]

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const started = Date.now()
    let status = 500
    let body = null
    try {
        const matching = routes.filter(([, pattern]) => pattern.test(url.pathname))
        const route = matching.find(([method]) => method === req.method)
        if (!route) {
            throw matching.length > 0
                ? new Problem(405, '/problems/method-not-allowed', 'Method not allowed', `${req.method} is not allowed`)
                : notFound(url.pathname)
        }
        const params = url.pathname.match(route[1]).slice(1)
        ;[status, body] = await route[2](req, url, params)
    } catch (e) {
        if (!(e instanceof Problem)) console.error(e)
        const p = e instanceof Problem ? e : new Problem(500, '/problems/internal', 'Internal error', 'Something broke')
        status = p.status
        body = { type: p.type, title: p.title, status: p.status, detail: p.detail }
    }
    const json = body == null ? '' : JSON.stringify(body)
    res.writeHead(status, {
        'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json',
        'Cache-Control': 'no-store',
    })
    res.end(json)
    if (process.env.LOG) console.log(`${req.method} ${url.pathname}${url.search} ${status} ${Date.now() - started}ms`)
})

seedHistory()
for (const m of markets) for (let i = 0; i < 20; i++) botTick(m)
for (const m of markets) {
    setInterval(() => botTick(m), between(380, 620))
}

server.listen(PORT, () => {
    console.log(`Fake core on http://localhost:${PORT}/api/v1 (markets: ${markets.map((m) => m.name).join(', ')})`)
})
