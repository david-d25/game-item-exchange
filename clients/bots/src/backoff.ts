import type { Rng } from './random.js';

export interface BackoffOptions {
    /** Ceiling of the first delay. */
    baseMs: number;
    /** No delay is ever longer than this. */
    maxMs: number;
}

/** Upper bound of the delay before retry number `attempt` (0-based): base · 2^attempt, capped. */
export function backoffCeiling(attempt: number, options: BackoffOptions): number {
    const exponent = Math.min(Math.max(attempt, 0), 30); // 2^30 already exceeds any sane cap
    return Math.min(options.maxMs, options.baseMs * 2 ** exponent);
}

/**
 * "Equal jitter": half of the ceiling is fixed and half is random. The delay grows with every attempt,
 * never exceeds the cap and never collapses to zero, while many clients retrying at once spread out.
 */
export function backoffDelay(attempt: number, options: BackoffOptions, rng: Rng): number {
    const ceiling = backoffCeiling(attempt, options);
    return ceiling / 2 + (rng() * ceiling) / 2;
}

/** Remembers the number of consecutive failures of one loop. */
export class Backoff {
    private attempt = 0;

    constructor(
        private readonly options: BackoffOptions,
        private readonly rng: Rng,
    ) {}

    /** The delay before the next try; every call makes the following one longer. */
    next(): number {
        return backoffDelay(this.attempt++, this.options, this.rng);
    }

    reset(): void {
        this.attempt = 0;
    }

    get failures(): number {
        return this.attempt;
    }
}
