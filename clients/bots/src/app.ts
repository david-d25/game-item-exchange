import { setMaxListeners } from 'node:events';
import { BotSession, InternalApi, PublicApi } from './api.js';
import { Backoff } from './backoff.js';
import { SweepScheduler, type Bot, type BotContext } from './bot.js';
import type { Config } from './config.js';
import { HttpClient } from './http.js';
import { createLogger, describeError, type Logger } from './log.js';
import { Maker } from './maker.js';
import { MarketRegistry } from './markets.js';
import type { Rng } from './random.js';
import { TokenBucket } from './rate-limiter.js';
import { abortError, isAbortError, sleep } from './sleep.js';
import { Stats } from './stats.js';
import { Taker } from './taker.js';
import { DEFAULT_TUNING, type Tuning } from './tuning.js';

export interface AppOptions {
    config: Config;
    tuning?: Partial<Tuning>;
    log?: Logger;
    rng?: Rng;
}

/** Leftover orders of a previous run are listed and canceled in up to this many pages of 200. */
const LEFTOVER_ROUNDS = 5;

/**
 * Runs all bots: waits for core, prepares the bot users, then keeps the loops going until `stop`.
 *
 * Shutdown has two signals. `stop` ends the loops at once: sleeps and rate-limit waits return. Requests
 * already in flight get a moment to finish, so the bot learns the ids of orders it has just placed,
 * and then `hard` cuts them off. After that every bot cancels its open orders within the time budget.
 */
export class BotApp {
    readonly stats = new Stats();
    readonly registry: MarketRegistry;
    readonly makers: Maker[] = [];
    readonly takers: Taker[] = [];

    private readonly tuning: Tuning;
    private readonly log: Logger;
    private readonly rng: Rng;
    private readonly http: HttpClient;
    private readonly publicApi: PublicApi;
    private readonly bucket: TokenBucket;
    private readonly stopController = new AbortController();
    private readonly hardController = new AbortController();
    private readonly loops = new Set<Promise<void>>();
    private loopsStarted = false;
    private lastSummaryAt = performance.now();
    private running: Promise<void> | undefined;
    private stopping: Promise<void> | undefined;

    constructor(private readonly options: AppOptions) {
        const { config } = options;
        this.tuning = { ...DEFAULT_TUNING, ...options.tuning };
        this.log = options.log ?? createLogger(config.logLevel, 'bots');
        this.rng = options.rng ?? Math.random;
        // Every sleep and request listens to these signals; there are many of them, but never unboundedly many
        setMaxListeners(1_000, this.stopController.signal, this.hardController.signal);

        const http = (this.http = new HttpClient({
            baseUrl: config.coreUrl,
            timeoutMs: this.tuning.requestTimeoutMs,
            maxAttempts: 4,
            backoff: { baseMs: 250, maxMs: 8_000 },
            rng: this.rng,
            log: this.log.child('http'),
        }));
        this.publicApi = new PublicApi(http);
        const internal = new InternalApi(http, config.internalToken);
        this.bucket = new TokenBucket(config.ordersPerSecond);
        this.registry = new MarketRegistry(this.tuning.priceWalk, this.rng);

        const ctx: BotContext = {
            tuning: this.tuning,
            registry: this.registry,
            publicApi: this.publicApi,
            internal,
            stats: this.stats,
            rng: this.rng,
            sweeps: new SweepScheduler(this.tuning.sweepMeanIntervalMs, this.rng, performance.now()),
            stop: this.stopController.signal,
            hard: this.hardController.signal,
            now: () => performance.now(),
        };
        const stop = this.stopController.signal;
        const gate = (): Promise<void> => this.bucket.take(stop);
        const session = (name: string): BotSession =>
            new BotSession(name, http, internal, this.log.child(name), gate, () => this.stats.add('signIns'));
        for (let i = 1; i <= config.makers; i++) {
            const name = `maker-${i}`;
            this.makers.push(new Maker(session(name), ctx, this.log.child(name)));
        }
        for (let i = 1; i <= config.takers; i++) {
            const name = `taker-${i}`;
            this.takers.push(new Taker(session(name), ctx, this.log.child(name)));
        }
    }

    private get bots(): Bot[] {
        return [...this.makers, ...this.takers];
    }

    /** Starts the bots. Resolves once they have stopped and cleaned up; rejects only on a bug. */
    run(): Promise<void> {
        this.running ??= this.main();
        return this.running;
    }

    /** Stops the loops and cancels open orders, within the shutdown budget. Safe to call more than once. */
    stop(reason = 'stop requested'): Promise<void> {
        this.stopping ??= this.shutdown(reason);
        return this.stopping;
    }

    private async main(): Promise<void> {
        const { config } = this.options;
        try {
            this.log.info(
                `starting ${config.makers} makers and ${config.takers} takers against ${config.coreUrl}, ` +
                    `at most ${config.ordersPerSecond} order requests per second`,
            );
            await this.waitUntilReady();
            await this.untilSuccess('reading the market list', () => this.refreshMarkets());
            await Promise.all(this.bots.map((bot) => this.untilSuccess(`signing in ${bot.name}`, () => bot.signIn())));
            await Promise.all(
                this.bots.map((bot) =>
                    bot.checkFunds().catch((error: unknown) => {
                        if (!this.stopController.signal.aborted) {
                            this.log.warn(`initial balance check of ${bot.name} failed, will retry: ${describeError(error)}`);
                        }
                    }),
                ),
            );
            await Promise.all(
                this.bots.map(async (bot) => {
                    const canceled = await bot.cancelAllOpen(this.hardController.signal, true, LEFTOVER_ROUNDS);
                    if (canceled > 0) {
                        this.log.info(`${bot.name}: canceled ${canceled} leftover orders of a previous run`);
                    }
                }),
            );
            if (!this.stopController.signal.aborted) {
                this.startLoops();
            }
        } catch (error) {
            if (!this.stopController.signal.aborted && !isAbortError(error)) {
                this.log.error(`startup failed: ${describeError(error)}`);
                await this.stop('startup failed');
                throw error;
            }
        }
        await new Promise<void>((resolve) => {
            if (this.stopController.signal.aborted) {
                resolve();
            } else {
                this.stopController.signal.addEventListener('abort', () => resolve(), { once: true });
            }
        });
        await this.stopping;
    }

    private startLoops(): void {
        this.loopsStarted = true;
        this.track(this.fairPriceLoop());
        this.track(this.marketsLoop());
        this.track(this.summaryLoop());
        for (const bot of this.bots) {
            this.track(bot.runFundsLoop());
        }
        for (const market of this.registry.active()) {
            this.startQuoting(market.id);
        }
        for (const taker of this.takers) {
            this.track(taker.run());
        }
        const markets = this.registry.active();
        if (markets.length === 0) {
            this.log.warn('no fungible markets yet; the list is read again every few minutes');
        }
        this.log.info(`trading in ${markets.length} markets: ${markets.map((m) => m.key).join(', ')}`);
    }

    private startQuoting(marketId: number): void {
        const market = this.registry.get(marketId);
        if (!market) {
            return;
        }
        for (const maker of this.makers) {
            const loop = maker.quote(market);
            if (loop) {
                this.track(loop);
            }
        }
    }

    private track(loop: Promise<void>): void {
        const tracked = loop.catch((error: unknown) => {
            this.stats.add('errors');
            this.log.error(`a loop failed unexpectedly: ${describeError(error)}`);
        });
        this.loops.add(tracked);
        void tracked.finally(() => this.loops.delete(tracked));
    }

    private async waitUntilReady(): Promise<void> {
        const backoff = new Backoff({ baseMs: 500, maxMs: this.tuning.readinessMaxDelayMs }, this.rng);
        for (;;) {
            const { ready, reason } = await this.publicApi.ready(this.hardController.signal);
            if (ready) {
                this.log.info('core is ready');
                return;
            }
            const delay = backoff.next();
            this.log.info(`waiting for core to become ready (${reason}), next check in ${(delay / 1000).toFixed(1)} s`);
            if (!(await sleep(delay, this.stopController.signal))) {
                throw abortError();
            }
        }
    }

    /** Repeats a startup step with backoff until it succeeds or the app stops. */
    private async untilSuccess<T>(what: string, step: () => Promise<T>): Promise<T> {
        const backoff = new Backoff({ baseMs: 1_000, maxMs: 30_000 }, this.rng);
        for (;;) {
            try {
                return await step();
            } catch (error) {
                if (this.stopController.signal.aborted) {
                    throw abortError();
                }
                const delay = backoff.next();
                this.stats.add('errors');
                this.log.warn(`${what} failed, retrying in ${(delay / 1000).toFixed(1)} s: ${describeError(error)}`);
                if (!(await sleep(delay, this.stopController.signal))) {
                    throw abortError();
                }
            }
        }
    }

    private async refreshMarkets(): Promise<void> {
        const summaries = await this.publicApi.markets(this.hardController.signal);
        const { added, removed } = this.registry.update(summaries);
        for (const market of added) {
            this.log.info(`market ${market.key} (id ${market.id}): fair price starts at ${market.anchor}`);
            if (this.loopsStarted) {
                this.startQuoting(market.id);
            }
        }
        for (const market of removed) {
            this.log.info(`market ${market.key} (id ${market.id}) is no longer listed, leaving it`);
        }
    }

    private async fairPriceLoop(): Promise<void> {
        let last = performance.now();
        while (await sleep(this.tuning.fairUpdateMs, this.stopController.signal)) {
            const now = performance.now();
            // After a long pause (a suspended laptop, a stalled process) do not jump all at once
            this.registry.step(Math.min((now - last) / 1000, 30));
            last = now;
        }
    }

    private async marketsLoop(): Promise<void> {
        const backoff = new Backoff({ baseMs: 5_000, maxMs: this.tuning.marketsRefreshMs }, this.rng);
        let delay = this.tuning.marketsRefreshMs;
        while (await sleep(delay, this.stopController.signal)) {
            try {
                await this.refreshMarkets();
                backoff.reset();
                delay = this.tuning.marketsRefreshMs;
            } catch (error) {
                if (this.stopController.signal.aborted) {
                    return;
                }
                this.stats.add('errors');
                this.log.warn(`reading the market list failed: ${describeError(error)}`);
                delay = backoff.next();
            }
        }
    }

    private async summaryLoop(): Promise<void> {
        this.lastSummaryAt = performance.now();
        while (await sleep(this.tuning.summaryMs, this.stopController.signal)) {
            this.logSummary();
        }
    }

    /** One line with the counts since the previous summary. */
    private logSummary(): void {
        const now = performance.now();
        const elapsedMs = now - this.lastSummaryAt;
        this.lastSummaryAt = now;
        const d = this.stats.sinceLastReport();
        const resting = this.makers.reduce((sum, maker) => sum + maker.restingOrders, 0);
        const fair = this.registry
            .active()
            .map((m) => `${m.defId} ${m.fair.price}`)
            .join(', ');
        const extras = [
            d.sweeps > 0 ? `sweeps ${d.sweeps}` : '',
            d.grants > 0 ? `grants ${d.grants}` : '',
            d.signIns > 0 ? `sign-ins ${d.signIns}` : '',
        ].filter((part) => part !== '');
        this.log.info(
            `last ${Math.round(elapsedMs / 1000)} s: placed ${d.placed}, canceled ${d.canceled}, fills ${d.fills}, ` +
                `errors ${d.errors}${extras.length > 0 ? `, ${extras.join(', ')}` : ''} | resting ${resting}, ` +
                `waiting for rate limit ${this.bucket.waiting} | fair: ${fair || 'none'} | ` +
                `rss ${Math.round(process.memoryUsage.rss() / 1_048_576)} MB`,
        );
    }

    private async shutdown(reason: string): Promise<void> {
        const started = performance.now();
        const budget = this.tuning.shutdownBudgetMs;
        this.log.info(`stopping (${reason}): ending loops and canceling open orders`);
        this.stopController.abort();

        // Requests in flight may finish for a moment, so the bot knows about orders it has just placed
        const settled = Promise.allSettled([...this.loops]);
        await settledWithin(settled, Math.min(1_500, budget / 3));
        this.hardController.abort();
        await settledWithin(settled, 500);

        const remaining = Math.max(500, budget - (performance.now() - started));
        const deadline = new AbortController();
        setMaxListeners(1_000, deadline.signal);
        const timer = setTimeout(() => deadline.abort(), remaining);
        try {
            const results = await Promise.all(this.bots.map((bot) => bot.cancelAllOpen(deadline.signal, false, 1)));
            const canceled = results.reduce((sum, n) => sum + n, 0);
            const left = this.makers.reduce((sum, maker) => sum + maker.restingOrders, 0);
            if (this.loopsStarted || canceled > 0) {
                this.logSummary();
            }
            this.log.info(
                `stopped in ${Math.round(performance.now() - started)} ms: canceled ${canceled} open orders` +
                    (left > 0 ? `, ${left} could not be canceled` : ''),
            );
        } finally {
            clearTimeout(timer);
            this.http.close();
        }
    }
}

/** Waits for the promise, but not longer than `ms`, and leaves no timer behind. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
    const timeout = new AbortController();
    await Promise.race([promise, sleep(ms, timeout.signal)]);
    timeout.abort();
}
