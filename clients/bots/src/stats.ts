export interface Counts {
    placed: number;
    canceled: number;
    fills: number;
    errors: number;
    grants: number;
    sweeps: number;
    signIns: number;
}

const ZERO: Counts = { placed: 0, canceled: 0, fills: 0, errors: 0, grants: 0, sweeps: 0, signIns: 0 };

/** Counters of all bots together. Only numbers: nothing here grows with time. */
export class Stats {
    private readonly total: Counts = { ...ZERO };
    private reported: Counts = { ...ZERO };

    add(key: keyof Counts, amount = 1): void {
        this.total[key] += amount;
    }

    totals(): Counts {
        return { ...this.total };
    }

    /** Counts since the previous call. */
    sinceLastReport(): Counts {
        const now = this.totals();
        const delta = { ...ZERO };
        for (const key of Object.keys(delta) as (keyof Counts)[]) {
            delta[key] = now[key] - this.reported[key];
        }
        this.reported = now;
        return delta;
    }
}
