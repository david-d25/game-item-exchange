import { gaussian, type Rng } from './random.js';

/**
 * Parameters of the fair-price walk. The log of price/anchor follows an Ornstein-Uhlenbeck process
 * (a random walk pulled back to zero) with rare jumps, and is reflected at hard bounds.
 */
export interface PriceWalkParams {
    /** Standard deviation of the diffusion part of the log price over one minute (0.004 = 0.4%). */
    sigmaPerMinute: number;
    /** Time in which an excursion from the anchor halves on average. */
    halfLifeMinutes: number;
    /** Average number of jumps per hour. */
    jumpsPerHour: number;
    /** Standard deviation of one jump of the log price. */
    jumpSigma: number;
    /** The price never leaves [minRatio, maxRatio] × anchor. */
    minRatio: number;
    maxRatio: number;
}

/**
 * About 0.4% per minute, which moves the 1-minute chart by a credit or more for typical prices, a jump of
 * about 1.5% every 20 minutes or so, and an excursion half-life of 6 hours. Long-run spread is about ±8%,
 * so the hard bounds of 0.62..1.6 are hardly ever touched.
 */
export const DEFAULT_PRICE_WALK: PriceWalkParams = {
    sigmaPerMinute: 0.004,
    halfLifeMinutes: 360,
    jumpsPerHour: 3,
    jumpSigma: 0.015,
    minRatio: 0.62,
    maxRatio: 1.6,
};

/** The fair price of one market, shared by all bots. */
export class FairPrice {
    /** log(price / anchor) */
    private deviation: number;
    private readonly low: number;
    private readonly high: number;

    constructor(
        readonly anchor: number,
        private readonly params: PriceWalkParams = DEFAULT_PRICE_WALK,
        private readonly rng: Rng = Math.random,
        initialRatio = 1,
    ) {
        if (!(anchor > 0) || !(params.minRatio > 0) || !(params.maxRatio > params.minRatio)) {
            throw new RangeError('The anchor must be positive and minRatio < maxRatio');
        }
        this.low = Math.log(params.minRatio);
        this.high = Math.log(params.maxRatio);
        this.deviation = reflect(Math.log(initialRatio), this.low, this.high);
    }

    /** Advances the walk by `seconds`. The exact OU transition is used, so the step size does not matter. */
    step(seconds: number): void {
        if (!(seconds > 0)) {
            return;
        }
        const { sigmaPerMinute, halfLifeMinutes, jumpsPerHour, jumpSigma } = this.params;
        const theta = Math.LN2 / (halfLifeMinutes * 60); // reversion speed per second
        const decay = Math.exp(-theta * seconds);
        const sigma = sigmaPerMinute / Math.sqrt(60); // per square root of a second
        const spread = sigma * Math.sqrt((1 - decay * decay) / (2 * theta));
        let next = this.deviation * decay + spread * gaussian(this.rng);
        // A jump happens with the probability of at least one Poisson event within the step
        if (this.rng() < 1 - Math.exp((-jumpsPerHour * seconds) / 3600)) {
            next += jumpSigma * gaussian(this.rng);
        }
        this.deviation = reflect(next, this.low, this.high);
    }

    /** The fair price with its fraction, for computing quotes. */
    get value(): number {
        return this.anchor * Math.exp(this.deviation);
    }

    /** The fair price as a whole number of credits, at least 1. */
    get price(): number {
        return Math.max(1, Math.round(this.value));
    }

    /** Fair price divided by the anchor. */
    get ratio(): number {
        return Math.exp(this.deviation);
    }
}

/** Mirrors x back into [low, high], like a ball bouncing off the walls. */
export function reflect(x: number, low: number, high: number): number {
    if (!Number.isFinite(x)) {
        return 0 >= low && 0 <= high ? 0 : low;
    }
    let y = x;
    for (let i = 0; i < 8 && (y < low || y > high); i++) {
        y = y < low ? 2 * low - y : 2 * high - y;
    }
    return Math.min(high, Math.max(low, y)); // a jump larger than the whole band ends at a wall
}
