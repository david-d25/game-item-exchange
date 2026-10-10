import { randomUUID } from 'node:crypto';
import type { BotSession } from './api.js';
import { Backoff } from './backoff.js';
import { Bot, LOOP_BACKOFF, type BotContext } from './bot.js';
import { MAKER_FUNDS } from './funds.js';
import { ApiError } from './http.js';
import { crossesOwn, planRequote, randomProfile, type LiveOrder, type MakerProfile, type Quote } from './ladder.js';
import type { Logger } from './log.js';
import type { MarketState } from './markets.js';
import { uniform } from './random.js';
import { isAbortError, sleep } from './sleep.js';

/** What a maker knows about its orders in one market. */
interface MakerBook {
    readonly market: MarketState;
    /** Orders believed to be resting in the book. */
    readonly live: Map<number, LiveOrder>;
    /** Orders whose cancel was accepted, with the time of the request: a refresh must not bring them back. */
    readonly canceling: Map<number, number>;
    running: boolean;
}

type PlaceResult = 'placed' | 'no-funds' | 'market-closed' | 'rejected';

/** How long a market is left alone after core says it is closed for trading. */
const MARKET_CLOSED_PAUSE_MS = 60_000;
/** Cancel requests older than this are forgotten even if the order still shows up. */
const CANCELING_TTL_MS = 60_000;
const MAX_CANCELING = 200;

/**
 * Keeps a ladder of GTC orders on both sides of every market around the fair price, and moves it
 * as the fair price moves. Each market has its own loop, so markets requote independently.
 */
export class Maker extends Bot {
    readonly profile: MakerProfile;
    private readonly books = new Map<number, MakerBook>();

    constructor(session: BotSession, ctx: BotContext, log: Logger) {
        super(session, ctx, log, MAKER_FUNDS);
        this.profile = randomProfile(ctx.rng);
        const p = this.profile;
        log.debug(
            `profile: ${p.levels} levels, best ${(p.firstOffset * 100).toFixed(2)}% from fair, ` +
                `spacing ${(p.spacing * 100).toFixed(2)}%, size x${p.sizeFactor.toFixed(2)}`,
        );
    }

    /** Starts quoting in a market. Returns the loop, or undefined if it is already running. */
    quote(market: MarketState): Promise<void> | undefined {
        let book = this.books.get(market.id);
        if (book?.running) {
            return undefined;
        }
        if (!book) {
            book = { market, live: new Map(), canceling: new Map(), running: true };
            this.books.set(market.id, book);
        }
        book.running = true;
        const running = book;
        return this.quoteLoop(running).finally(() => {
            running.running = false;
        });
    }

    /** Number of orders this maker believes are resting, all markets together. */
    get restingOrders(): number {
        let count = 0;
        for (const book of this.books.values()) {
            count += book.live.size;
        }
        return count;
    }

    protected override knownOpenOrders(): number[] {
        return [...this.books.values()].flatMap((book) => [...book.live.keys()]);
    }

    protected override forgetOrders(orderIds: readonly number[]): void {
        for (const book of this.books.values()) {
            for (const orderId of orderIds) {
                book.live.delete(orderId);
            }
        }
    }

    private async quoteLoop(book: MakerBook): Promise<void> {
        const { tuning, stop, rng } = this.ctx;
        // Spread the first requotes of all makers and markets over a moment
        if (!(await sleep(uniform(rng, 0, Math.min(2_000, tuning.requoteMinMs)), stop))) {
            return;
        }
        const backoff = new Backoff(LOOP_BACKOFF, rng);
        while (book.market.active && !stop.aborted) {
            let delay = uniform(rng, tuning.requoteMinMs, tuning.requoteMaxMs);
            try {
                if (this.ctx.now() >= book.market.pausedUntil) {
                    await this.requote(book);
                }
                backoff.reset();
            } catch (error) {
                if (stop.aborted || isAbortError(error)) {
                    return;
                }
                this.reportError(`requote in ${book.market.key}`, error);
                delay = backoff.next();
            }
            if (!(await sleep(delay, stop))) {
                return;
            }
        }
        if (!book.market.active && book.live.size > 0) {
            // The market disappeared from the list: do not leave orders behind in it
            for (const order of [...book.live.values()]) {
                await this.cancel(book, order).catch(() => undefined);
            }
        }
    }

    /**
     * One requote: read the own orders of the market, cancel stale ones, place the missing levels.
     * The read comes first every time: a filled level must be replaced at the next requote, not after
     * the next periodic refresh, or the book thins out between refreshes.
     */
    private async requote(book: MakerBook): Promise<void> {
        const { tuning, stop } = this.ctx;
        await this.refresh(book);
        const plan = planRequote({
            fair: book.market.fair.value,
            profile: this.profile,
            size: book.market.size,
            live: [...book.live.values()],
            now: this.ctx.now(),
            rng: this.ctx.rng,
            maxOrders: tuning.maxOrdersPerMarket,
        });
        for (const order of plan.cancel) {
            if (stop.aborted) {
                return;
            }
            await this.cancel(book, order);
        }
        const blocked = new Set<Quote['side']>();
        for (const quote of plan.place) {
            if (stop.aborted || book.live.size >= tuning.maxOrdersPerMarket) {
                return;
            }
            if (blocked.has(quote.side)) {
                continue;
            }
            // Checked again against what is actually live: a cancel above may have failed
            if (crossesOwn(quote.side, quote.price, book.live.values())) {
                this.log.debug(`skipped ${quote.side} @ ${quote.price} in ${book.market.key}: would cross own order`);
                continue;
            }
            const result = await this.place(book, quote);
            if (result === 'market-closed') {
                return;
            }
            if (result === 'no-funds') {
                blocked.add(quote.side);
            }
        }
    }

    private async place(book: MakerBook, quote: Quote): Promise<PlaceResult> {
        const { market } = book;
        // One id per intent: the HTTP client sends this same body again if it has to retry
        const request = {
            clientOrderId: randomUUID(),
            marketId: market.id,
            side: quote.side,
            price: quote.price,
            quantity: quote.quantity,
            timeInForce: 'GTC' as const,
        };
        try {
            const placed = await this.session.place(request, this.ctx.hard);
            const now = this.ctx.now();
            book.live.set(placed.orderId, {
                orderId: placed.orderId,
                side: quote.side,
                price: quote.price,
                quantity: quote.quantity,
                filled: 0,
                placedAt: now,
                expiresAt: now + uniform(this.ctx.rng, this.ctx.tuning.orderLifetimeMinMs, this.ctx.tuning.orderLifetimeMaxMs),
            });
            this.ctx.stats.add('placed');
            this.log.debug(`placed ${quote.side} ${quote.quantity} @ ${quote.price} in ${market.key} (order ${placed.orderId})`);
            return 'placed';
        } catch (error) {
            if (error instanceof ApiError && !error.retryable) {
                if (error.is('insufficient-funds') || error.is('insufficient-items')) {
                    this.log.debug(`${error.problem} for ${quote.side} ${quote.quantity} @ ${quote.price} in ${market.key}`);
                    this.requestFundsCheck();
                    return 'no-funds';
                }
                if (error.is('market-closed')) {
                    this.log.warn(`${market.key} is closed for trading, pausing it for a minute`);
                    market.pausedUntil = this.ctx.now() + MARKET_CLOSED_PAUSE_MS;
                    return 'market-closed';
                }
                this.reportError(`${quote.side} ${quote.quantity} @ ${quote.price} in ${market.key}`, error);
                return 'rejected';
            }
            // Unknown outcome: the order may exist without the bot knowing its id. The refresh at the start
            // of the next requote adopts it, and until then nothing more is placed here.
            throw error;
        }
    }

    private async cancel(book: MakerBook, order: LiveOrder): Promise<void> {
        try {
            const result = await this.session.cancel(order.orderId, this.ctx.hard);
            book.live.delete(order.orderId);
            if (result === 'requested') {
                book.canceling.set(order.orderId, this.ctx.now());
                if (book.canceling.size > MAX_CANCELING) {
                    // Maps iterate in insertion order: the first key is the oldest request
                    book.canceling.delete(book.canceling.keys().next().value!);
                }
                this.ctx.stats.add('canceled');
                this.log.debug(`canceled ${order.side} @ ${order.price} in ${book.market.key} (order ${order.orderId})`);
            } else {
                // Closed before the cancel arrived: a GTC order closes on its own only when it is filled
                this.ctx.stats.add('fills');
            }
        } catch (error) {
            if (error instanceof ApiError && !error.retryable) {
                // The order stays in the local list, so new orders still avoid crossing it
                this.reportError(`cancel of order ${order.orderId}`, error);
                return;
            }
            throw error;
        }
    }

    /**
     * Brings the local list in line with core: orders that are gone were filled (or closed otherwise),
     * fills are counted, and orders the bot did not know about (a placement whose response was lost) are adopted.
     */
    private async refresh(book: MakerBook): Promise<void> {
        const { tuning, rng } = this.ctx;
        const startedAt = this.ctx.now();
        const orders = await this.session.orders({ status: 'ACTIVE', marketId: book.market.id, limit: 100 }, this.ctx.hard);
        const now = this.ctx.now();

        const active = new Set<number>();
        for (const order of orders) {
            if (order.marketId !== book.market.id || order.status === 'CLOSED' || order.timeInForce !== 'GTC') {
                continue;
            }
            active.add(order.orderId);
            if (book.canceling.has(order.orderId)) {
                continue;
            }
            const known = book.live.get(order.orderId);
            if (known) {
                if (order.filled > known.filled) {
                    known.filled = order.filled;
                    this.ctx.stats.add('fills');
                }
                continue;
            }
            this.log.debug(`adopted order ${order.orderId} (${order.side} @ ${order.price}) in ${book.market.key}`);
            book.live.set(order.orderId, {
                orderId: order.orderId,
                side: order.side,
                price: order.price,
                quantity: order.quantity,
                filled: order.filled,
                placedAt: now,
                expiresAt: now + uniform(rng, tuning.orderLifetimeMinMs, tuning.orderLifetimeMaxMs),
            });
        }
        for (const [orderId, order] of book.live) {
            // Orders placed while the list was being fetched may be missing from it
            if (!active.has(orderId) && order.placedAt < startedAt) {
                book.live.delete(orderId);
                this.ctx.stats.add('fills');
                this.log.debug(`order ${orderId} (${order.side} @ ${order.price}) in ${book.market.key} was filled`);
            }
        }
        for (const [orderId, requestedAt] of book.canceling) {
            if (!active.has(orderId) || now - requestedAt > CANCELING_TTL_MS) {
                book.canceling.delete(orderId);
            }
        }
    }
}
