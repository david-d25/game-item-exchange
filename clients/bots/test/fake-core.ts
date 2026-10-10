import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { seededRng, type Rng } from '../src/random.js';

/**
 * An in-memory stand-in for core with the endpoints of docs/api.md that the bots use. Orders are accepted
 * with 202 PENDING and matched a few milliseconds later, strictly in arrival order, like the real matcher
 * behind Kafka. It records everything the tests want to check: orders, trades, self-trades, rejected requests.
 */

export interface FakeMarket {
    marketId: number;
    gameId: string;
    defId: string;
    name: string;
    kind: 'FUNGIBLE' | 'UNIQUE';
    lastPrice: number | null;
}

type Side = 'BUY' | 'SELL';
type Status = 'PENDING' | 'OPEN' | 'CLOSED';

export interface FakeOrder {
    orderId: number;
    clientOrderId: string;
    ownerId: number;
    marketId: number;
    side: Side;
    price: number;
    quantity: number;
    filled: number;
    timeInForce: 'GTC' | 'IOC' | 'FOK';
    status: Status;
    closeReason: string | null;
    createdAt: string;
    /** When the request arrived, in ms since the core started. */
    acceptedAt: number;
}

export interface FakeTrade {
    marketId: number;
    price: number;
    quantity: number;
    buyerId: number;
    sellerId: number;
    takerSide: Side;
    at: number;
}

interface Holding {
    available: number;
    reserved: number;
}

export interface FakeUser {
    userId: number;
    name: string;
    available: number;
    reserved: number;
    items: Map<number, Holding>;
}

type Command = { kind: 'place'; order: FakeOrder } | { kind: 'cancel'; orderId: number };

export interface FakeCoreOptions {
    internalToken: string;
    markets: FakeMarket[];
    /** The first this many readiness checks answer 503. */
    notReadyFor?: number;
    /** Share of API requests that fail with 503, 429 or a 500 after the work was done (a lost response). */
    faultRate?: number;
    matcherDelayMs?: number;
    seed?: number;
}

/** A request to place or cancel, with the time it arrived: the tests check the rate limit with these. */
export interface OrderRequestRecord {
    kind: 'place' | 'cancel';
    at: number;
}

const MAX_VALUE = 1_000_000_000;
const FEE_PERCENT = 5;

class HttpProblem extends Error {
    constructor(
        readonly status: number,
        readonly type: string,
        detail: string,
    ) {
        super(detail);
    }
}

export class FakeCore {
    readonly users = new Map<number, FakeUser>();
    readonly orders = new Map<number, FakeOrder>();
    readonly trades: FakeTrade[] = [];
    /** Self-trades and own crossing orders: must stay empty. */
    readonly violations: string[] = [];
    readonly grants: { userId: number; credits: number; items: { marketId: number; quantity: number }[] }[] = [];
    /** 4xx answers by problem type. */
    readonly problems = new Map<string, number>();
    readonly orderRequests: OrderRequestRecord[] = [];
    tokensIssued = 0;
    faultRate: number;

    private readonly markets = new Map<number, FakeMarket>();
    private readonly usersByName = new Map<string, FakeUser>();
    private readonly tokens = new Map<string, number>();
    private readonly resting = new Map<number, FakeOrder[]>();
    private readonly queue: Command[] = [];
    private readonly server: http.Server;
    private readonly rng: Rng;
    private readonly started = performance.now();
    private readinessChecks = 0;
    private nextUserId = 1;
    private nextOrderId = 1_000;
    private matcherTimer: NodeJS.Timeout | undefined;
    private idleWaiters: (() => void)[] = [];
    private port = 0;

    constructor(private readonly options: FakeCoreOptions) {
        for (const market of options.markets) {
            this.markets.set(market.marketId, { ...market });
        }
        this.faultRate = options.faultRate ?? 0;
        this.rng = seededRng(options.seed ?? 1);
        this.server = http.createServer((req, res) => {
            this.handle(req, res).catch((error: unknown) => {
                if (!res.headersSent) {
                    this.send(res, 500, { type: '/problems/internal', detail: String(error) }, 'application/problem+json');
                }
            });
        });
    }

    get url(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    async start(): Promise<void> {
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        this.port = (this.server.address() as AddressInfo).port;
    }

    async stop(): Promise<void> {
        clearTimeout(this.matcherTimer);
        this.server.closeAllConnections();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    addMarket(market: FakeMarket): void {
        this.markets.set(market.marketId, { ...market });
    }

    /** Every token stops working at once, as if they all expired. */
    revokeAllTokens(): void {
        this.tokens.clear();
    }

    /** Resolves once the matcher has processed every command received so far. */
    idle(): Promise<void> {
        if (this.queue.length === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }

    now(): number {
        return performance.now() - this.started;
    }

    userByName(name: string): FakeUser | undefined {
        return this.usersByName.get(name);
    }

    ordersOf(userId: number): FakeOrder[] {
        return [...this.orders.values()].filter((order) => order.ownerId === userId);
    }

    /** An order of a "previous run": the bot user exists and has a resting order before the bots start. */
    seedRestingOrder(name: string, marketId: number, side: Side, price: number, quantity: number): FakeOrder {
        const user = this.user(name);
        if (side === 'BUY') {
            user.available += price * quantity;
        } else {
            this.holding(user, marketId).available += quantity;
        }
        const order = this.accept(user, { clientOrderId: randomUUID(), marketId, side, price, quantity, timeInForce: 'GTC' });
        this.match(order);
        return order;
    }

    // ---- HTTP ----

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://fake');
        const method = req.method ?? 'GET';
        const body = await readBody(req);
        const path = url.pathname;

        if (method === 'GET' && path === '/actuator/health/readiness') {
            this.readinessChecks++;
            const up = this.readinessChecks > (this.options.notReadyFor ?? 0);
            this.send(res, up ? 200 : 503, { status: up ? 'UP' : 'DOWN' });
            return;
        }

        const isOrderRequest = method === 'POST' && (path === '/api/v1/orders' || /^\/api\/v1\/orders\/\d+\/cancel$/.test(path));
        if (isOrderRequest) {
            this.orderRequests.push({ kind: path === '/api/v1/orders' ? 'place' : 'cancel', at: this.now() });
        }

        // Faults: either nothing happens, or the work is done and the response is lost
        let loseResponse = false;
        if (this.faultRate > 0 && this.rng() < this.faultRate) {
            const kind = this.rng();
            if (kind < 0.33) {
                this.send(res, 503, { type: '/problems/unavailable', title: 'Unavailable', status: 503 }, 'application/problem+json');
                return;
            }
            if (kind < 0.66) {
                res.setHeader('retry-after', '0');
                this.send(res, 429, { type: '/problems/too-many-requests', status: 429 }, 'application/problem+json');
                return;
            }
            loseResponse = true;
        }

        try {
            const [status, payload] = this.route(method, path, url.searchParams, body, req.headers);
            if (loseResponse) {
                this.send(res, 500, { type: '/problems/internal', title: 'Internal error', status: 500 }, 'application/problem+json');
                return;
            }
            this.send(res, status, payload);
        } catch (error) {
            if (error instanceof HttpProblem) {
                const short = error.type.slice(error.type.lastIndexOf('/') + 1);
                this.problems.set(short, (this.problems.get(short) ?? 0) + 1);
                this.send(res, error.status, { type: error.type, title: short, status: error.status, detail: error.message }, 'application/problem+json');
                return;
            }
            throw error;
        }
    }

    private route(
        method: string,
        path: string,
        query: URLSearchParams,
        body: unknown,
        headers: http.IncomingHttpHeaders,
    ): [number, unknown] {
        let m: RegExpMatchArray | null;
        if (path.startsWith('/internal/')) {
            if (headers['x-internal-token'] !== this.options.internalToken) {
                throw new HttpProblem(403, '/problems/forbidden', 'wrong internal token');
            }
            if (method === 'POST' && path === '/internal/v1/bots') {
                return [200, this.botLogin(body)];
            }
            if (method === 'POST' && (m = path.match(/^\/internal\/v1\/users\/(\d+)\/grants$/))) {
                this.grant(Number(m[1]), body);
                return [204, undefined];
            }
        }
        if (method === 'GET' && path === '/api/v1/markets') {
            return [200, [...this.markets.values()].sort((a, b) => a.marketId - b.marketId).map((market) => this.summary(market))];
        }
        if (method === 'GET' && (m = path.match(/^\/api\/v1\/markets\/(\d+)\/book$/))) {
            return [200, this.book(Number(m[1]), Number(query.get('depth') ?? 50))];
        }
        if (path.startsWith('/api/v1/me') || path.startsWith('/api/v1/orders')) {
            const user = this.authenticate(headers);
            if (method === 'GET' && path === '/api/v1/me/wallet') {
                return [200, { available: user.available, reserved: user.reserved }];
            }
            if (method === 'GET' && path === '/api/v1/me/inventory') {
                return [200, this.inventory(user)];
            }
            if (method === 'GET' && path === '/api/v1/me/orders') {
                return [200, this.listOrders(user, query)];
            }
            if (method === 'POST' && path === '/api/v1/orders') {
                return this.placeOrder(user, body);
            }
            if (method === 'GET' && (m = path.match(/^\/api\/v1\/orders\/(\d+)$/))) {
                return [200, view(this.ownOrder(user, Number(m[1])))];
            }
            if (method === 'POST' && (m = path.match(/^\/api\/v1\/orders\/(\d+)\/cancel$/))) {
                this.requestCancel(user, Number(m[1]));
                return [202, undefined];
            }
        }
        throw new HttpProblem(404, '/problems/not-found', `${method} ${path} not found`);
    }

    private send(res: http.ServerResponse, status: number, payload: unknown, contentType = 'application/json'): void {
        if (payload === undefined) {
            res.writeHead(status).end();
            return;
        }
        res.writeHead(status, { 'content-type': contentType }).end(JSON.stringify(payload));
    }

    // ---- users and funds ----

    private user(name: string): FakeUser {
        let user = this.usersByName.get(name);
        if (!user) {
            user = { userId: this.nextUserId++, name, available: 0, reserved: 0, items: new Map() };
            this.users.set(user.userId, user);
            this.usersByName.set(name, user);
        }
        return user;
    }

    private holding(user: FakeUser, marketId: number): Holding {
        let holding = user.items.get(marketId);
        if (!holding) {
            holding = { available: 0, reserved: 0 };
            user.items.set(marketId, holding);
        }
        return holding;
    }

    private botLogin(body: unknown): unknown {
        const name = (body as { name?: unknown } | undefined)?.name;
        if (typeof name !== 'string' || !/^[a-z0-9-]{1,32}$/.test(name)) {
            throw new HttpProblem(400, '/problems/invalid-request', 'bad bot name');
        }
        const user = this.user(name);
        const token = randomUUID();
        this.tokens.set(token, user.userId);
        this.tokensIssued++;
        return { userId: user.userId, displayName: name, token };
    }

    private grant(userId: number, body: unknown): void {
        const user = this.users.get(userId);
        if (!user) {
            throw new HttpProblem(404, '/problems/not-found', 'no such user');
        }
        const grant = body as { credits?: unknown; items?: unknown };
        if (!isWhole(grant.credits, 0) || !Array.isArray(grant.items)) {
            throw new HttpProblem(400, '/problems/invalid-request', 'bad grant');
        }
        const items: { marketId: number; quantity: number }[] = [];
        for (const item of grant.items as { marketId?: unknown; quantity?: unknown }[]) {
            const market = this.markets.get(Number(item.marketId));
            if (!market || market.kind !== 'FUNGIBLE' || !isWhole(item.quantity, 1)) {
                throw new HttpProblem(400, '/problems/invalid-request', 'bad grant item');
            }
            items.push({ marketId: market.marketId, quantity: item.quantity });
        }
        user.available += grant.credits;
        for (const item of items) {
            this.holding(user, item.marketId).available += item.quantity;
        }
        this.grants.push({ userId, credits: grant.credits, items });
    }

    private authenticate(headers: http.IncomingHttpHeaders): FakeUser {
        const token = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
        const userId = token === undefined ? undefined : this.tokens.get(token);
        const user = userId === undefined ? undefined : this.users.get(userId);
        if (!user) {
            throw new HttpProblem(401, '/problems/unauthorized', 'The request is not authenticated');
        }
        return user;
    }

    private inventory(user: FakeUser): unknown {
        const fungible = [...user.items.entries()]
            .filter(([, holding]) => holding.available > 0 || holding.reserved > 0)
            .map(([marketId, holding]) => {
                const market = this.markets.get(marketId)!;
                return { marketId, gameId: market.gameId, defId: market.defId, name: market.name, ...holding };
            });
        return { fungible, unique: [] };
    }

    // ---- market data ----

    private summary(market: FakeMarket): unknown {
        const trades = this.trades.filter((trade) => trade.marketId === market.marketId);
        const book = this.book(market.marketId, 1);
        return {
            marketId: market.marketId,
            marketKey: `${market.gameId}/${market.defId}`,
            gameId: market.gameId,
            gameName: 'Idle Mine',
            defId: market.defId,
            name: market.name,
            kind: market.kind,
            lastPrice: trades.at(-1)?.price ?? market.lastPrice,
            open24h: trades[0]?.price ?? null,
            volume24h: trades.reduce((sum, trade) => sum + trade.quantity, 0),
            trades24h: trades.length,
            bestBid: book.bids[0]?.price ?? null,
            bestAsk: book.asks[0]?.price ?? null,
        };
    }

    private book(marketId: number, depth: number): { marketId: number; marketKey: string; sequence: number; asks: Level[]; bids: Level[] } {
        const market = this.markets.get(marketId);
        if (!market) {
            throw new HttpProblem(404, '/problems/not-found', `Market ${marketId} not found`);
        }
        if (!Number.isInteger(depth) || depth < 1 || depth > 500) {
            throw new HttpProblem(400, '/problems/invalid-request', 'depth must be between 1 and 500');
        }
        const resting = this.resting.get(marketId) ?? [];
        return {
            marketId,
            marketKey: `${market.gameId}/${market.defId}`,
            sequence: this.trades.length,
            asks: levels(resting.filter((o) => o.side === 'SELL'), (a, b) => a - b).slice(0, depth),
            bids: levels(resting.filter((o) => o.side === 'BUY'), (a, b) => b - a).slice(0, depth),
        };
    }

    // ---- orders ----

    private listOrders(user: FakeUser, query: URLSearchParams): unknown[] {
        const status = query.get('status') ?? 'ACTIVE';
        const limit = Number(query.get('limit') ?? 50);
        const marketId = query.get('marketId');
        if (!['ACTIVE', 'CLOSED', 'ALL'].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
            throw new HttpProblem(400, '/problems/invalid-request', 'bad order filter');
        }
        return this.ordersOf(user.userId)
            .filter((order) => marketId === null || order.marketId === Number(marketId))
            .filter((order) => status === 'ALL' || (status === 'CLOSED') === (order.status === 'CLOSED'))
            .sort((a, b) => b.orderId - a.orderId)
            .slice(0, limit)
            .map(view);
    }

    private ownOrder(user: FakeUser, orderId: number): FakeOrder {
        const order = this.orders.get(orderId);
        if (!order || order.ownerId !== user.userId) {
            throw new HttpProblem(404, '/problems/not-found', `Order ${orderId} not found`);
        }
        return order;
    }

    private placeOrder(user: FakeUser, body: unknown): [number, unknown] {
        const request = (body ?? {}) as Record<string, unknown>;
        const { clientOrderId, marketId, side, price, quantity } = request;
        const timeInForce = request['timeInForce'] ?? 'GTC';
        if (
            typeof clientOrderId !== 'string' ||
            clientOrderId.length < 1 ||
            clientOrderId.length > 64 ||
            (side !== 'BUY' && side !== 'SELL') ||
            (timeInForce !== 'GTC' && timeInForce !== 'IOC' && timeInForce !== 'FOK') ||
            !isWhole(price, 1, MAX_VALUE) ||
            !isWhole(quantity, 1, MAX_VALUE) ||
            typeof marketId !== 'number'
        ) {
            throw new HttpProblem(400, '/problems/invalid-request', `malformed order ${JSON.stringify(body)}`);
        }
        const market = this.markets.get(marketId);
        if (!market) {
            throw new HttpProblem(404, '/problems/not-found', `Market ${marketId} not found`);
        }
        if (market.kind !== 'FUNGIBLE') {
            this.violations.push(`${user.name} sent an order without an asset to the unique market ${marketId}`);
            throw new HttpProblem(400, '/problems/invalid-request', 'A sell order of a unique item needs assetId and quantity 1');
        }
        const existing = [...this.orders.values()].find((o) => o.ownerId === user.userId && o.clientOrderId === clientOrderId);
        if (existing) {
            const same =
                existing.marketId === marketId &&
                existing.side === side &&
                existing.price === price &&
                existing.quantity === quantity &&
                existing.timeInForce === timeInForce;
            if (!same) {
                throw new HttpProblem(409, '/problems/client-order-id-reused', `clientOrderId ${clientOrderId} was used for a different order`);
            }
            return [200, { orderId: existing.orderId, status: existing.status }];
        }
        if (side === 'BUY') {
            if (user.available < price * quantity) {
                throw new HttpProblem(422, '/problems/insufficient-funds', `needs ${price * quantity}, ${user.available} available`);
            }
        } else if (this.holding(user, marketId).available < quantity) {
            throw new HttpProblem(422, '/problems/insufficient-items', `You do not have ${quantity} items to sell`);
        }
        const order = this.accept(user, { clientOrderId, marketId, side, price, quantity, timeInForce });
        this.enqueue({ kind: 'place', order });
        return [202, { orderId: order.orderId, status: 'PENDING' }];
    }

    /** Stores the order and reserves what it needs. */
    private accept(
        user: FakeUser,
        r: { clientOrderId: string; marketId: number; side: Side; price: number; quantity: number; timeInForce: 'GTC' | 'IOC' | 'FOK' },
    ): FakeOrder {
        if (r.side === 'BUY') {
            user.available -= r.price * r.quantity;
            user.reserved += r.price * r.quantity;
        } else {
            const holding = this.holding(user, r.marketId);
            holding.available -= r.quantity;
            holding.reserved += r.quantity;
        }
        const order: FakeOrder = {
            orderId: this.nextOrderId++,
            ownerId: user.userId,
            filled: 0,
            status: 'PENDING',
            closeReason: null,
            createdAt: new Date().toISOString(),
            acceptedAt: this.now(),
            ...r,
        };
        this.orders.set(order.orderId, order);
        return order;
    }

    private requestCancel(user: FakeUser, orderId: number): void {
        const order = this.ownOrder(user, orderId);
        if (order.status === 'CLOSED') {
            throw new HttpProblem(409, '/problems/order-closed', `Order ${orderId} is already closed`);
        }
        this.enqueue({ kind: 'cancel', orderId });
    }

    // ---- matcher ----

    private enqueue(command: Command): void {
        this.queue.push(command);
        this.matcherTimer ??= setTimeout(() => this.drain(), this.options.matcherDelayMs ?? 3);
    }

    private drain(): void {
        this.matcherTimer = undefined;
        while (this.queue.length > 0) {
            const command = this.queue.shift()!;
            if (command.kind === 'place') {
                this.match(command.order);
            } else {
                this.cancel(command.orderId);
            }
        }
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }

    private match(order: FakeOrder): void {
        const book = this.resting.get(order.marketId) ?? [];
        this.resting.set(order.marketId, book);
        const crosses = (other: FakeOrder): boolean =>
            other.side !== order.side && (order.side === 'BUY' ? other.price <= order.price : other.price >= order.price);
        const candidates = book
            .filter(crosses)
            .sort((a, b) => (order.side === 'BUY' ? a.price - b.price : b.price - a.price) || a.orderId - b.orderId);

        if (order.timeInForce === 'FOK') {
            const fillable = candidates.reduce((sum, o) => sum + o.quantity - o.filled, 0);
            if (fillable < order.quantity) {
                this.close(order, 'FOK_UNFILLED');
                return;
            }
        }
        for (const resting of candidates) {
            const quantity = Math.min(order.quantity - order.filled, resting.quantity - resting.filled);
            if (quantity <= 0) {
                break;
            }
            if (resting.ownerId === order.ownerId) {
                this.violations.push(
                    `self-trade of ${this.users.get(order.ownerId)?.name}: ${order.side} @ ${order.price} (order ${order.orderId}) ` +
                        `met own ${resting.side} @ ${resting.price} (order ${resting.orderId}) in market ${order.marketId}`,
                );
            }
            this.trade(order.side === 'BUY' ? order : resting, order.side === 'BUY' ? resting : order, resting.price, quantity, order.side);
            if (resting.filled === resting.quantity) {
                this.close(resting, 'FILLED');
            }
        }
        if (order.filled === order.quantity) {
            this.close(order, 'FILLED');
        } else if (order.timeInForce === 'GTC') {
            order.status = 'OPEN';
            book.push(order);
            this.checkOwnCross(order.ownerId, order.marketId);
        } else {
            this.close(order, 'IOC_UNFILLED');
        }
    }

    private trade(buy: FakeOrder, sell: FakeOrder, price: number, quantity: number, takerSide: Side): void {
        const buyer = this.users.get(buy.ownerId)!;
        const seller = this.users.get(sell.ownerId)!;
        buyer.reserved -= buy.price * quantity;
        buyer.available += (buy.price - price) * quantity;
        this.holding(buyer, buy.marketId).available += quantity;
        this.holding(seller, sell.marketId).reserved -= quantity;
        const value = price * quantity;
        seller.available += value - Math.floor((value * FEE_PERCENT) / 100);
        buy.filled += quantity;
        sell.filled += quantity;
        this.trades.push({ marketId: buy.marketId, price, quantity, buyerId: buyer.userId, sellerId: seller.userId, takerSide, at: this.now() });
    }

    private cancel(orderId: number): void {
        const order = this.orders.get(orderId);
        if (order && order.status !== 'CLOSED') {
            this.close(order, 'CANCELED');
        }
    }

    /** Closes the order and returns the reservation of its unfilled rest. */
    private close(order: FakeOrder, reason: string): void {
        const book = this.resting.get(order.marketId);
        const index = book?.indexOf(order) ?? -1;
        if (index >= 0) {
            book!.splice(index, 1);
        }
        const rest = order.quantity - order.filled;
        const owner = this.users.get(order.ownerId)!;
        if (order.side === 'BUY') {
            owner.reserved -= order.price * rest;
            owner.available += order.price * rest;
        } else {
            const holding = this.holding(owner, order.marketId);
            holding.reserved -= rest;
            holding.available += rest;
        }
        order.status = 'CLOSED';
        order.closeReason = reason;
    }

    private checkOwnCross(ownerId: number, marketId: number): void {
        const own = (this.resting.get(marketId) ?? []).filter((o) => o.ownerId === ownerId);
        const highestBuy = Math.max(...own.filter((o) => o.side === 'BUY').map((o) => o.price));
        const lowestSell = Math.min(...own.filter((o) => o.side === 'SELL').map((o) => o.price));
        if (highestBuy >= lowestSell) {
            this.violations.push(`${this.users.get(ownerId)?.name} has crossing orders in market ${marketId}: buy ${highestBuy} >= sell ${lowestSell}`);
        }
    }
}

interface Level {
    price: number;
    quantity: number;
    orders: number;
}

function levels(orders: FakeOrder[], compare: (a: number, b: number) => number): Level[] {
    const byPrice = new Map<number, Level>();
    for (const order of orders) {
        const level = byPrice.get(order.price) ?? { price: order.price, quantity: 0, orders: 0 };
        level.quantity += order.quantity - order.filled;
        level.orders++;
        byPrice.set(order.price, level);
    }
    return [...byPrice.values()].sort((a, b) => compare(a.price, b.price));
}

function view(order: FakeOrder): unknown {
    return {
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        marketId: order.marketId,
        side: order.side,
        price: order.price,
        quantity: order.quantity,
        filled: order.filled,
        timeInForce: order.timeInForce,
        assetId: null,
        targetOrderId: null,
        status: order.status,
        closeReason: order.closeReason,
        createdAt: order.createdAt,
    };
}

function isWhole(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '') {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
