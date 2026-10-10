import { randomUUID } from 'node:crypto';
import type { BookLevel, BotSession, Side } from './api.js';
import { Backoff } from './backoff.js';
import { Bot, LOOP_BACKOFF, type BotContext } from './bot.js';
import { TAKER_FUNDS } from './funds.js';
import { ApiError } from './http.js';
import type { Logger } from './log.js';
import type { MarketState } from './markets.js';
import { exponential, pick, randomInt, type Rng } from './random.js';
import { isAbortError, sleep } from './sleep.js';

/** A taker never pays more than this above the fair price (or sells this much below it)... */
const TRADE_BAND = 0.05;
/** ...and a sweep no more than this: a stray order of a human must not be taken at any price. */
const SWEEP_BAND = 0.08;
const BOOK_DEPTH = 10;
const MARKET_CLOSED_PAUSE_MS = 60_000;

/**
 * Probability of buying. A mid price below fair makes buying more likely, which pulls the price back up,
 * and the other way round: 1% below fair gives 75%. Never certain, so both sides keep trading.
 */
export function buyProbability(fair: number, mid: number): number {
    const gap = (fair - mid) / fair;
    return Math.min(0.85, Math.max(0.15, 0.5 + 25 * gap));
}

export function chooseSide(rng: Rng, fair: number, bestBid: number | undefined, bestAsk: number | undefined): Side {
    const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk ?? fair);
    return rng() < buyProbability(fair, mid) ? 'BUY' : 'SELL';
}

/**
 * Takes liquidity at random moments: an IOC order at the best opposite price for a small quantity,
 * and once in a while a sweep through two or three levels that leaves a spike on the chart.
 */
export class Taker extends Bot {
    constructor(session: BotSession, ctx: BotContext, log: Logger) {
        super(session, ctx, log, TAKER_FUNDS);
    }

    // IOC orders never rest in the book, so a taker has nothing to track
    protected override knownOpenOrders(): number[] {
        return [];
    }

    protected override forgetOrders(): void {}

    async run(): Promise<void> {
        const { tuning, stop, rng } = this.ctx;
        const backoff = new Backoff(LOOP_BACKOFF, rng);
        let delay = exponential(rng, tuning.takerMeanIntervalMs);
        while (await sleep(delay, stop)) {
            delay = exponential(rng, tuning.takerMeanIntervalMs);
            const now = this.ctx.now();
            const market = pick(rng, this.ctx.registry.active().filter((m) => now >= m.pausedUntil));
            if (!market) {
                continue;
            }
            try {
                await this.trade(market);
                backoff.reset();
            } catch (error) {
                if (stop.aborted || isAbortError(error)) {
                    return;
                }
                this.reportError(`trade in ${market.key}`, error);
                delay = Math.max(delay, backoff.next());
            }
        }
    }

    private async trade(market: MarketState): Promise<void> {
        const { publicApi, hard, stop, rng, stats, tuning } = this.ctx;
        const book = await publicApi.book(market.id, BOOK_DEPTH, hard);
        const fair = market.fair.value;
        const side = chooseSide(rng, fair, book.bids[0]?.price, book.asks[0]?.price);
        const levels: BookLevel[] = side === 'BUY' ? book.asks : book.bids;
        if (levels.length === 0) {
            this.log.debug(`nothing to ${side === 'BUY' ? 'buy' : 'sell'} into in ${market.key}`);
            return;
        }
        const within = (price: number, band: number): boolean =>
            side === 'BUY' ? price <= fair * (1 + band) : price >= fair * (1 - band);

        let depth = 1;
        if (levels.length >= 2 && this.ctx.sweeps.claim(this.ctx.now())) {
            depth = Math.min(levels.length, randomInt(rng, 2, 3));
            while (depth > 1 && !within(levels[depth - 1]!.price, SWEEP_BAND)) {
                depth--;
            }
        }
        const sweep = depth > 1;
        const price = levels[depth - 1]!.price;
        if (!within(price, sweep ? SWEEP_BAND : TRADE_BAND)) {
            this.log.debug(`best ${side === 'BUY' ? 'ask' : 'bid'} ${price} in ${market.key} is too far from fair ${fair.toFixed(1)}`);
            return;
        }
        const { min, max } = market.size;
        const quantity = sweep
            ? Math.min(
                  levels.slice(0, depth).reduce((sum, level) => sum + level.quantity, 0),
                  3 * max,
              )
            : Math.min(levels[0]!.quantity, randomInt(rng, min, Math.max(min, Math.ceil(max / 2))));

        const request = {
            clientOrderId: randomUUID(),
            marketId: market.id,
            side,
            price,
            quantity,
            timeInForce: 'IOC' as const,
        };
        let orderId: number;
        try {
            orderId = (await this.session.place(request, hard)).orderId;
        } catch (error) {
            if (error instanceof ApiError && !error.retryable) {
                if (error.is('insufficient-funds') || error.is('insufficient-items')) {
                    this.log.debug(`${error.problem} for ${side} ${quantity} @ ${price} in ${market.key}`);
                    this.requestFundsCheck();
                } else if (error.is('market-closed')) {
                    this.log.warn(`${market.key} is closed for trading, pausing it for a minute`);
                    market.pausedUntil = this.ctx.now() + MARKET_CLOSED_PAUSE_MS;
                } else {
                    this.reportError(`${side} ${quantity} @ ${price} in ${market.key}`, error);
                }
                return;
            }
            throw error;
        }
        stats.add('placed');
        if (sweep) {
            stats.add('sweeps');
        }

        // The matcher works asynchronously: look at the outcome a moment later, for the fills counter and the log
        if (!(await sleep(tuning.fillCheckDelayMs, stop))) {
            return;
        }
        let outcome: string;
        try {
            const result = await this.session.order(orderId, hard);
            if (result.filled > 0) {
                stats.add('fills');
            }
            outcome = result.status === 'CLOSED' ? `filled ${result.filled}` : `still ${result.status}`;
        } catch (error) {
            if (stop.aborted || isAbortError(error)) {
                return;
            }
            outcome = 'outcome unknown';
        }
        const what = `${side} ${quantity} @ ${price} in ${market.key} (order ${orderId}): ${outcome}`;
        if (sweep) {
            this.log.info(`sweep through ${depth} levels: ${what}`);
        } else {
            this.log.debug(what);
        }
    }
}
