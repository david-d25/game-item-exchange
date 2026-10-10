import type { BotSession, Grant, InternalApi, PublicApi } from './api.js';
import { Backoff } from './backoff.js';
import { planGrant, type FundsPolicy } from './funds.js';
import { ApiError } from './http.js';
import { describeError, type Logger } from './log.js';
import type { MarketRegistry } from './markets.js';
import { exponential, jitter, type Rng } from './random.js';
import { isAbortError, sleep, Wakeable } from './sleep.js';
import type { Stats } from './stats.js';
import type { Tuning } from './tuning.js';

/** Decides when the next big sweep happens: about once per `meanMs`, all takers together. */
export class SweepScheduler {
    private nextAt: number;

    constructor(
        private readonly meanMs: number,
        private readonly rng: Rng,
        now: number,
    ) {
        this.nextAt = now + exponential(rng, meanMs);
    }

    /** True at most once per scheduled sweep: the caller that gets it performs the sweep. */
    claim(now: number): boolean {
        if (now < this.nextAt) {
            return false;
        }
        this.nextAt = now + exponential(this.rng, this.meanMs);
        return true;
    }
}

/** Everything the bots share. */
export interface BotContext {
    readonly tuning: Tuning;
    readonly registry: MarketRegistry;
    readonly publicApi: PublicApi;
    readonly internal: InternalApi;
    readonly stats: Stats;
    readonly rng: Rng;
    readonly sweeps: SweepScheduler;
    /** Aborted on shutdown: loops end, sleeps and rate-limit waits return at once. */
    readonly stop: AbortSignal;
    /** Aborted a moment after `stop`: requests still in flight are cut off. */
    readonly hard: AbortSignal;
    /** Monotonic milliseconds. */
    readonly now: () => number;
}

/** Backoff of a loop after consecutive failures. */
export const LOOP_BACKOFF = { baseMs: 1_000, maxMs: 60_000 };

const CLEANUP_CONCURRENCY = 4;

export abstract class Bot {
    private readonly fundsWake = new Wakeable();
    private lastFundsCheck = Number.NEGATIVE_INFINITY;

    protected constructor(
        readonly session: BotSession,
        protected readonly ctx: BotContext,
        protected readonly log: Logger,
        private readonly funds: FundsPolicy,
    ) {}

    get name(): string {
        return this.session.name;
    }

    async signIn(): Promise<void> {
        const login = await this.session.signIn(this.ctx.hard);
        this.log.info(`signed in as user ${login.userId}`);
    }

    /** Reads wallet and inventory and grants one generous top-up if anything is below its threshold. */
    async checkFunds(): Promise<void> {
        this.lastFundsCheck = this.ctx.now();
        const signal = this.ctx.hard;
        const [wallet, inventory] = await Promise.all([this.session.wallet(signal), this.session.inventory(signal)]);
        const markets = this.ctx.registry.active();
        const grant = planGrant(this.funds, wallet, inventory, markets);
        const userId = this.session.userId;
        if (grant === null || userId === undefined) {
            return;
        }
        await this.ctx.internal.grant(userId, grant, signal);
        this.ctx.stats.add('grants');
        this.log.info(`topped up (had ${wallet.available} credits available): ${this.describeGrant(grant)}`);
    }

    /** Asks the funds loop to check soon, for example after an order was rejected for lack of funds. */
    requestFundsCheck(): void {
        this.fundsWake.poke();
    }

    /** Checks the balances every minute or so, and sooner when asked to. */
    async runFundsLoop(): Promise<void> {
        const { tuning, stop } = this.ctx;
        const backoff = new Backoff(LOOP_BACKOFF, this.ctx.rng);
        let delay = jitter(this.ctx.rng, tuning.fundsCheckMs, 0.15);
        while (await this.fundsWake.sleep(delay, stop)) {
            const sinceLast = this.ctx.now() - this.lastFundsCheck;
            if (sinceLast < tuning.fundsCheckMinGapMs && !(await sleep(tuning.fundsCheckMinGapMs - sinceLast, stop))) {
                break;
            }
            try {
                await this.checkFunds();
                backoff.reset();
                delay = jitter(this.ctx.rng, tuning.fundsCheckMs, 0.15);
            } catch (error) {
                if (stop.aborted || isAbortError(error)) {
                    break;
                }
                this.reportError('balance check', error);
                delay = backoff.next();
            }
        }
    }

    /** Orders this bot believes are open. */
    protected abstract knownOpenOrders(): number[];

    /** Forgets orders after they were canceled. */
    protected abstract forgetOrders(orderIds: readonly number[]): void;

    /**
     * Cancels every open order of this bot: the ones it knows about plus whatever core lists as active.
     * `limited` requests go through the shared rate limit; the shutdown cleanup skips it to finish in time.
     * Returns the number of orders canceled. Best effort: failures are logged, never thrown.
     */
    async cancelAllOpen(signal: AbortSignal, limited: boolean, rounds: number): Promise<number> {
        if (this.session.userId === undefined) {
            return 0; // never signed in, so it has placed nothing
        }
        let total = 0;
        for (let round = 0; round < rounds && !signal.aborted; round++) {
            const ids = new Set(this.knownOpenOrders());
            const limit = 200;
            let listed = 0;
            try {
                const active = await this.session.orders({ status: 'ACTIVE', limit }, signal);
                listed = active.length;
                for (const order of active) {
                    if (order.status !== 'CLOSED') {
                        ids.add(order.orderId);
                    }
                }
            } catch (error) {
                if (signal.aborted) {
                    break;
                }
                this.log.warn(`could not list open orders: ${describeError(error)}`);
            }
            const done = await this.cancelMany([...ids], signal, limited);
            total += done.length;
            this.forgetOrders(done);
            // A full page means there may be more on the next one
            if (listed < limit) {
                break;
            }
        }
        return total;
    }

    private async cancelMany(ids: readonly number[], signal: AbortSignal, limited: boolean): Promise<number[]> {
        const done: number[] = [];
        let next = 0;
        const worker = async (): Promise<void> => {
            while (next < ids.length && !signal.aborted) {
                const orderId = ids[next++]!;
                try {
                    const result = await this.session.cancel(orderId, signal, limited);
                    done.push(orderId);
                    if (result === 'requested') {
                        this.ctx.stats.add('canceled');
                    }
                } catch (error) {
                    if (!signal.aborted && !isAbortError(error)) {
                        this.log.warn(`could not cancel order ${orderId}: ${describeError(error)}`);
                    }
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(CLEANUP_CONCURRENCY, ids.length) }, worker));
        return done;
    }

    /** Logs a failed operation with the Problem Details type and counts it. */
    protected reportError(what: string, error: unknown): void {
        this.ctx.stats.add('errors');
        if (error instanceof ApiError) {
            this.log.warn(`${what} failed: ${error.status} ${error.type}${error.detail ? ` (${error.detail})` : ''}`);
        } else {
            this.log.warn(`${what} failed: ${describeError(error)}`);
        }
    }

    private describeGrant(grant: Grant): string {
        const parts: string[] = [];
        if (grant.credits > 0) {
            parts.push(`${grant.credits} credits`);
        }
        for (const item of grant.items) {
            const market = this.ctx.registry.get(item.marketId);
            parts.push(`${item.quantity} ${market?.defId ?? `market ${item.marketId}`}`);
        }
        return parts.join(', ');
    }
}
