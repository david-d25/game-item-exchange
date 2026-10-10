/** A source of uniform random numbers in [0, 1). `Math.random` in production, seeded in tests. */
export type Rng = () => number;

/** Mulberry32: a tiny seeded generator, good enough for simulations and reproducible tests. */
export function seededRng(seed: number): Rng {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function uniform(rng: Rng, min: number, max: number): number {
    return min + (max - min) * rng();
}

/** A random integer between min and max, both inclusive. */
export function randomInt(rng: Rng, min: number, max: number): number {
    return min + Math.floor(rng() * (max - min + 1));
}

/** Standard normal variable (Box-Muller). */
export function gaussian(rng: Rng): number {
    const u = 1 - rng(); // (0, 1]: log(0) is not allowed
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Exponentially distributed value with the given mean: the waiting time of a Poisson process. */
export function exponential(rng: Rng, mean: number): number {
    return -mean * Math.log(1 - rng());
}

export function pick<T>(rng: Rng, items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[Math.floor(rng() * items.length)];
}

/** The value changed by up to ±fraction of itself, so that periodic loops of many bots do not align. */
export function jitter(rng: Rng, value: number, fraction: number): number {
    return value * (1 + fraction * (2 * rng() - 1));
}
