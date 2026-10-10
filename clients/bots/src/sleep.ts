/**
 * Waits for `ms` milliseconds. Resolves to true when the time has passed and to false as soon as the signal
 * is aborted, so loops can write `if (!(await sleep(ms, signal))) break;`. Never rejects.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, Math.max(0, ms));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * A sleep that can be cut short from outside, for loops that normally run on a timer but sometimes
 * have to act sooner (for example, a balance check right after an order was rejected for lack of funds).
 */
export class Wakeable {
    private wake: (() => void) | undefined;
    private pending = false;

    /** Like `sleep`, but also ends early (resolving to true) when `poke` is called. */
    sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) {
            return Promise.resolve(false);
        }
        if (this.pending) {
            this.pending = false;
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            const finish = (result: boolean): void => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                this.wake = undefined;
                resolve(result);
            };
            const onAbort = (): void => finish(false);
            const timer = setTimeout(() => finish(true), Math.max(0, ms));
            signal?.addEventListener('abort', onAbort, { once: true });
            this.wake = () => finish(true);
        });
    }

    /** Ends the current sleep, or makes the next one return immediately. */
    poke(): void {
        if (this.wake) {
            this.wake();
        } else {
            this.pending = true;
        }
    }
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function abortError(): Error {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}
