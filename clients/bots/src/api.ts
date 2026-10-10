import { ApiError, type HttpClient } from './http.js';
import type { Logger } from './log.js';

// Shapes of docs/api.md. Only the fields the bots use are listed.

export type Side = 'BUY' | 'SELL';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';
export type OrderStatus = 'PENDING' | 'OPEN' | 'CLOSED';

export interface MarketSummary {
    marketId: number;
    marketKey: string;
    gameId: string;
    defId: string;
    name: string;
    kind: string;
    lastPrice: number | null;
    bestBid: number | null;
    bestAsk: number | null;
}

export interface BookLevel {
    price: number;
    quantity: number;
    orders: number;
}

export interface Book {
    marketId: number;
    asks: BookLevel[];
    bids: BookLevel[];
}

export interface Order {
    orderId: number;
    clientOrderId: string;
    marketId: number;
    side: Side;
    price: number;
    quantity: number;
    filled: number;
    timeInForce: TimeInForce;
    status: OrderStatus;
    closeReason: string | null;
}

export interface Wallet {
    available: number;
    reserved: number;
}

export interface FungibleHolding {
    marketId: number;
    defId: string;
    available: number;
    reserved: number;
}

export interface Inventory {
    fungible: FungibleHolding[];
}

export interface PlaceOrderRequest {
    clientOrderId: string;
    marketId: number;
    side: Side;
    price: number;
    quantity: number;
    timeInForce: TimeInForce;
}

export interface PlacedOrder {
    orderId: number;
    status: OrderStatus;
}

export interface BotLogin {
    userId: number;
    displayName: string;
    token: string;
}

export interface Grant {
    credits: number;
    items: { marketId: number; quantity: number }[];
}

export type OrderStatusFilter = 'ACTIVE' | 'CLOSED' | 'ALL';

/** Endpoints that need no user. */
export class PublicApi {
    constructor(private readonly http: HttpClient) {}

    /** True when core answers the readiness probe with 200. Makes one attempt and never throws. */
    async ready(signal: AbortSignal): Promise<{ ready: boolean; reason: string }> {
        try {
            await this.http.request({ method: 'GET', path: '/actuator/health/readiness', signal, maxAttempts: 1 });
            return { ready: true, reason: 'UP' };
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            if (error instanceof ApiError) {
                return { ready: false, reason: `HTTP ${error.status}` };
            }
            return { ready: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }

    async markets(signal: AbortSignal): Promise<MarketSummary[]> {
        const response = await this.http.request<MarketSummary[]>({ method: 'GET', path: '/api/v1/markets', signal });
        return expectArray(response.body, 'GET /api/v1/markets');
    }

    async book(marketId: number, depth: number, signal: AbortSignal): Promise<Book> {
        const response = await this.http.request<Book>({
            method: 'GET',
            path: `/api/v1/markets/${marketId}/book`,
            query: { depth },
            signal,
        });
        const book = response.body;
        return {
            marketId,
            asks: expectArray(book?.asks, 'book asks'),
            bids: expectArray(book?.bids, 'book bids'),
        };
    }
}

/** `/internal/v1`: reachable on core directly, never through the gateway. */
export class InternalApi {
    constructor(
        private readonly http: HttpClient,
        private readonly internalToken: string,
    ) {}

    async bot(name: string, signal: AbortSignal): Promise<BotLogin> {
        const response = await this.http.request<BotLogin>({
            method: 'POST',
            path: '/internal/v1/bots',
            headers: this.headers(),
            body: { name },
            signal,
        });
        const login = response.body;
        if (typeof login?.token !== 'string' || typeof login.userId !== 'number') {
            throw new Error(`POST /internal/v1/bots returned an unexpected body for ${name}`);
        }
        return login;
    }

    async grant(userId: number, grant: Grant, signal: AbortSignal): Promise<void> {
        await this.http.request({
            method: 'POST',
            path: `/internal/v1/users/${userId}/grants`,
            headers: this.headers(),
            body: grant,
            signal,
        });
    }

    private headers(): Record<string, string> {
        return { 'x-internal-token': this.internalToken };
    }
}

/**
 * One bot user: its token and the endpoints that act as it. On 401 it fetches a fresh token through the
 * internal API and repeats the request once.
 */
export class BotSession {
    private login: BotLogin | undefined;
    private refreshing: Promise<BotLogin> | undefined;

    constructor(
        readonly name: string,
        private readonly http: HttpClient,
        private readonly internal: InternalApi,
        private readonly log: Logger,
        /** Called before every attempt of an order or cancel request: the shared rate limit. */
        private readonly orderGate: () => Promise<void>,
        private readonly onTokenRefresh: () => void = () => {},
    ) {}

    get userId(): number | undefined {
        return this.login?.userId;
    }

    /** Gets or creates the bot user and a token for it. Concurrent callers share one request. */
    async signIn(signal: AbortSignal): Promise<BotLogin> {
        if (!this.refreshing) {
            this.refreshing = this.internal
                .bot(this.name, signal)
                .then((login) => {
                    this.login = login;
                    return login;
                })
                .finally(() => {
                    this.refreshing = undefined;
                });
        }
        return this.refreshing;
    }

    async wallet(signal: AbortSignal): Promise<Wallet> {
        const wallet = await this.call<Wallet>({ method: 'GET', path: '/api/v1/me/wallet', signal });
        if (typeof wallet?.available !== 'number') {
            throw new Error('GET /api/v1/me/wallet returned an unexpected body');
        }
        return wallet;
    }

    async inventory(signal: AbortSignal): Promise<Inventory> {
        const inventory = await this.call<Inventory>({ method: 'GET', path: '/api/v1/me/inventory', signal });
        return { fungible: expectArray(inventory?.fungible, 'inventory') };
    }

    async orders(
        filter: { status: OrderStatusFilter; marketId?: number; limit: number },
        signal: AbortSignal,
    ): Promise<Order[]> {
        const orders = await this.call<Order[]>({
            method: 'GET',
            path: '/api/v1/me/orders',
            query: { status: filter.status, marketId: filter.marketId, limit: filter.limit },
            signal,
        });
        return expectArray(orders, 'GET /api/v1/me/orders');
    }

    async order(orderId: number, signal: AbortSignal): Promise<Order> {
        return this.call<Order>({ method: 'GET', path: `/api/v1/orders/${orderId}`, signal });
    }

    /** Retries reuse the same request body, and so the same clientOrderId. */
    async place(request: PlaceOrderRequest, signal: AbortSignal, limited = true): Promise<PlacedOrder> {
        const placed = await this.call<PlacedOrder>({
            method: 'POST',
            path: '/api/v1/orders',
            body: request,
            signal,
            ...(limited ? { beforeAttempt: this.orderGate } : {}),
        });
        if (typeof placed?.orderId !== 'number') {
            throw new Error('POST /api/v1/orders returned an unexpected body');
        }
        return placed;
    }

    /**
     * Asks core to cancel an order. Resolves to "requested" on 202, or "closed" when the order is already
     * closed or unknown, which for the bot means the same thing: it is no longer in the book.
     */
    async cancel(orderId: number, signal: AbortSignal, limited = true): Promise<'requested' | 'closed'> {
        try {
            await this.call({
                method: 'POST',
                path: `/api/v1/orders/${orderId}/cancel`,
                signal,
                ...(limited ? { beforeAttempt: this.orderGate } : {}),
            });
            return 'requested';
        } catch (error) {
            if (error instanceof ApiError && (error.is('order-closed') || error.status === 404)) {
                return 'closed';
            }
            throw error;
        }
    }

    private async call<T>(spec: {
        method: 'GET' | 'POST';
        path: string;
        query?: Record<string, string | number | undefined>;
        body?: unknown;
        signal: AbortSignal;
        beforeAttempt?: () => Promise<void>;
    }): Promise<T> {
        const used = this.login?.token ?? (await this.signIn(spec.signal)).token;
        try {
            return (await this.http.request<T>({ ...spec, headers: bearer(used) })).body;
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 401) {
                throw error;
            }
            // Expired or revoked: get a fresh token the same way as at startup and repeat once.
            // Requests that failed with the same old token share one sign-in.
            if (this.login?.token === used) {
                if (!this.refreshing) {
                    this.log.info('token was rejected with 401, signing in again');
                    this.onTokenRefresh();
                }
                await this.signIn(spec.signal);
            } else if (this.refreshing) {
                await this.refreshing;
            }
            return (await this.http.request<T>({ ...spec, headers: bearer(this.login?.token ?? '') })).body;
        }
    }
}

function bearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
}

function expectArray<T>(value: unknown, what: string): T[] {
    if (!Array.isArray(value)) {
        throw new Error(`${what}: expected a JSON array`);
    }
    return value as T[];
}
