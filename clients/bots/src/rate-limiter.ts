import { abortError } from './sleep.js';

interface Waiter {
    resolve: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal | undefined;
    onAbort: () => void;
}

/**
 * Token bucket shared by all bots: every order or cancel request takes one token. Tokens come back at
 * `ratePerSecond`, and at most `capacity` of them can be saved up for a burst. Waiters are served first in,
 * first out, so a maker placing a whole ladder cannot starve a taker forever.
 */
export class TokenBucket {
    private tokens: number;
    private last: number;
    private readonly queue: Waiter[] = [];
    private timer: NodeJS.Timeout | undefined;

    constructor(
        readonly ratePerSecond: number,
        readonly capacity: number = Math.max(1, ratePerSecond),
        private readonly now: () => number = () => performance.now(),
    ) {
        if (!(ratePerSecond > 0) || !(capacity >= 1)) {
            throw new RangeError('The rate must be positive and the capacity at least 1');
        }
        this.tokens = capacity;
        this.last = now();
    }

    /** Takes a token if one is available right now and nobody is waiting for it. */
    tryTake(): boolean {
        this.refill();
        if (this.queue.length === 0 && this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        return false;
    }

    /** Waits for a token. Rejects with an AbortError if the signal is aborted first. */
    take(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            return Promise.reject(abortError());
        }
        if (this.tryTake()) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
                resolve,
                reject,
                signal,
                onAbort: () => {
                    const index = this.queue.indexOf(waiter);
                    if (index >= 0) {
                        this.queue.splice(index, 1);
                    }
                    if (this.queue.length === 0) {
                        this.clearTimer();
                    }
                    reject(abortError());
                },
            };
            signal?.addEventListener('abort', waiter.onAbort, { once: true });
            this.queue.push(waiter);
            this.schedule();
        });
    }

    /** Number of requests waiting for a token. */
    get waiting(): number {
        return this.queue.length;
    }

    private refill(): void {
        const now = this.now();
        const elapsed = Math.max(0, now - this.last);
        this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.ratePerSecond) / 1000);
        this.last = now;
    }

    private schedule(): void {
        if (this.timer !== undefined || this.queue.length === 0) {
            return;
        }
        this.refill();
        const missing = Math.max(0, 1 - this.tokens);
        const delay = Math.ceil((missing * 1000) / this.ratePerSecond);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.drain();
        }, delay);
    }

    private drain(): void {
        this.refill();
        while (this.queue.length > 0 && this.tokens >= 1) {
            this.tokens -= 1;
            const waiter = this.queue.shift()!;
            waiter.signal?.removeEventListener('abort', waiter.onAbort);
            waiter.resolve();
        }
        this.schedule();
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}
