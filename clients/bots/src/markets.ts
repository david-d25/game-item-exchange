import type { MarketSummary } from './api.js';
import { FairPrice, type PriceWalkParams } from './price.js';
import type { Rng } from './random.js';

/** Typical prices of the demo catalog (docs/api.md), used when a market has no trades yet. */
export const CATALOG_PRICES: Readonly<Record<string, number>> = {
    iron_ore: 300,
    coal: 120,
    crystal: 2500,
};

/** Anchor of an item the bots know nothing about. */
export const DEFAULT_PRICE = 100;

/** Prices from this many credits up count as expensive: smaller quantities, fewer items in stock. */
export const EXPENSIVE_FROM = 1000;

/** Order quantities, before the per-maker size factor. */
export interface SizeRange {
    min: number;
    max: number;
}

export interface MarketState {
    readonly id: number;
    readonly key: string;
    readonly defId: string;
    readonly name: string;
    readonly anchor: number;
    readonly fair: FairPrice;
    readonly size: SizeRange;
    readonly expensive: boolean;
    /** False once the market disappears from GET /markets. */
    active: boolean;
    /** Monotonic time until which nobody trades here, for example after a market-closed error. */
    pausedUntil: number;
}

/**
 * The market's last price, or the catalog price if there were no trades. For catalog items the last price
 * is kept within 0.5..2 times the catalog price: the bots re-anchor on every restart, and without a limit
 * a few restarts (or one stray trade at price 1 by a human) would let the anchor wander off for good.
 */
export function anchorFor(summary: Pick<MarketSummary, 'defId' | 'lastPrice'>): number {
    const reference = CATALOG_PRICES[summary.defId];
    const last = summary.lastPrice;
    if (last === null || !Number.isFinite(last) || last < 1) {
        return reference ?? DEFAULT_PRICE;
    }
    if (reference === undefined) {
        return Math.round(last);
    }
    return Math.round(Math.min(reference * 2, Math.max(reference / 2, last)));
}

export function sizeRangeFor(defId: string, price: number): SizeRange {
    switch (defId) {
        case 'crystal':
            return { min: 1, max: 3 };
        case 'coal':
            return { min: 5, max: 40 };
        case 'iron_ore':
            return { min: 3, max: 25 };
        default:
            if (price >= EXPENSIVE_FROM) {
                return { min: 1, max: 3 };
            }
            return price >= 200 ? { min: 3, max: 25 } : { min: 5, max: 40 };
    }
}

/** The markets the bots trade in, with their fair prices. Only fungible markets: unique items need assets. */
export class MarketRegistry {
    private readonly markets = new Map<number, MarketState>();

    constructor(
        private readonly walk: PriceWalkParams,
        private readonly rng: Rng,
    ) {}

    /**
     * Applies a fresh market list. Returns the markets that appeared (or came back) and those that are gone.
     * A market that comes back keeps its fair price.
     */
    update(summaries: readonly MarketSummary[]): { added: MarketState[]; removed: MarketState[] } {
        const listed = new Set<number>();
        const added: MarketState[] = [];
        for (const summary of summaries) {
            if (summary.kind !== 'FUNGIBLE' || !Number.isInteger(summary.marketId)) {
                continue;
            }
            listed.add(summary.marketId);
            const known = this.markets.get(summary.marketId);
            if (known) {
                if (!known.active) {
                    known.active = true;
                    added.push(known);
                }
                continue;
            }
            const anchor = anchorFor(summary);
            const market: MarketState = {
                id: summary.marketId,
                key: summary.marketKey,
                defId: summary.defId,
                name: summary.name,
                anchor,
                fair: new FairPrice(anchor, this.walk, this.rng),
                size: sizeRangeFor(summary.defId, anchor),
                expensive: anchor >= EXPENSIVE_FROM,
                active: true,
                pausedUntil: 0,
            };
            this.markets.set(market.id, market);
            added.push(market);
        }
        const removed: MarketState[] = [];
        for (const market of this.markets.values()) {
            if (market.active && !listed.has(market.id)) {
                market.active = false;
                removed.push(market);
            }
        }
        return { added, removed };
    }

    active(): MarketState[] {
        return [...this.markets.values()].filter((market) => market.active);
    }

    get(marketId: number): MarketState | undefined {
        return this.markets.get(marketId);
    }

    /** Advances every fair price, including those of inactive markets, so a market that returns is not stale. */
    step(seconds: number): void {
        for (const market of this.markets.values()) {
            market.fair.step(seconds);
        }
    }
}
