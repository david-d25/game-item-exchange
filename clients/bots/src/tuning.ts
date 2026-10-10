import { DEFAULT_PRICE_WALK, type PriceWalkParams } from './price.js';

/** Timings and limits. Not configurable through the environment: tests pass faster values. */
export interface Tuning {
    /** How often the fair prices move. */
    fairUpdateMs: number;
    /** How often the market list is read again, to pick up new markets. */
    marketsRefreshMs: number;
    /** Pause between two requotes of one maker in one market, drawn uniformly from this range. */
    requoteMinMs: number;
    requoteMaxMs: number;
    /** A maker order is replaced after a lifetime drawn from this range. */
    orderLifetimeMinMs: number;
    orderLifetimeMaxMs: number;
    maxOrdersPerMarket: number;
    /** Mean pause between two trades of one taker (exponentially distributed). */
    takerMeanIntervalMs: number;
    /** Mean pause between two big sweeps, all takers together. */
    sweepMeanIntervalMs: number;
    /** How long a taker waits before reading the result of its IOC order. */
    fillCheckDelayMs: number;
    fundsCheckMs: number;
    /** Balance checks requested after rejected orders are not run more often than this. */
    fundsCheckMinGapMs: number;
    summaryMs: number;
    /** Time limit of the cleanup on SIGTERM/SIGINT. */
    shutdownBudgetMs: number;
    readinessMaxDelayMs: number;
    requestTimeoutMs: number;
    priceWalk: PriceWalkParams;
}

export const DEFAULT_TUNING: Tuning = {
    fairUpdateMs: 3_000,
    marketsRefreshMs: 180_000,
    requoteMinMs: 8_000,
    requoteMaxMs: 20_000,
    orderLifetimeMinMs: 60_000,
    orderLifetimeMaxMs: 90_000,
    maxOrdersPerMarket: 10,
    takerMeanIntervalMs: 5_000,
    sweepMeanIntervalMs: 180_000,
    fillCheckDelayMs: 700,
    fundsCheckMs: 60_000,
    fundsCheckMinGapMs: 5_000,
    summaryMs: 60_000,
    shutdownBudgetMs: 5_000,
    readinessMaxDelayMs: 30_000,
    requestTimeoutMs: 10_000,
    priceWalk: DEFAULT_PRICE_WALK,
};
