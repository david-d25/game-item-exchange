import type { Side } from './api.js';
import type { SizeRange } from './markets.js';
import { randomInt, uniform, type Rng } from './random.js';

/** How one maker quotes. Every maker draws its own, so their ladders differ. */
export interface MakerProfile {
    /** Levels per side. */
    levels: number;
    /** Distance of the best level from the fair price, as a fraction (0.005 = 0.5%). */
    firstOffset: number;
    /** Distance between neighbouring levels, as a fraction. */
    spacing: number;
    /** Multiplies the quantities of this maker. */
    sizeFactor: number;
}

export function randomProfile(rng: Rng): MakerProfile {
    return {
        levels: randomInt(rng, 3, 5),
        firstOffset: uniform(rng, 0.003, 0.01),
        spacing: uniform(rng, 0.003, 0.008),
        sizeFactor: uniform(rng, 0.7, 1.3),
    };
}

export interface Quote {
    side: Side;
    price: number;
    quantity: number;
}

/** A resting order of the maker, as the maker knows it. */
export interface LiveOrder {
    orderId: number;
    side: Side;
    price: number;
    quantity: number;
    filled: number;
    /** Monotonic time when the bot placed or first saw the order. */
    placedAt: number;
    /** Monotonic time after which the order is replaced even if its price is still fine. */
    expiresAt: number;
}

const MAX_PRICE = 1_000_000_000;

/**
 * Prices of the ladder around `fair`, best first: whole credits, at least 1, strictly below the fair price
 * for bids and strictly above it for asks, and distinct within a side even when the percentage spacing is
 * less than one credit. Bids that would fall below 1 are left out.
 */
export function ladderPrices(fair: number, profile: MakerProfile): { bids: number[]; asks: number[] } {
    const bids: number[] = [];
    const asks: number[] = [];
    // Each level is at least one credit beyond the previous one of its side, so once a bid falls below 1
    // (or an ask above the maximum) every further level of that side would too
    let bid = Math.ceil(fair);
    let ask = Math.floor(fair);
    for (let level = 0; level < profile.levels; level++) {
        const offset = profile.firstOffset + level * profile.spacing;
        bid = Math.min(Math.floor(fair * (1 - offset)), bid - 1);
        if (bid >= 1) {
            bids.push(bid);
        }
        ask = Math.max(Math.ceil(fair * (1 + offset)), ask + 1);
        if (ask <= MAX_PRICE) {
            asks.push(ask);
        }
    }
    return { bids, asks };
}

/** The full ladder with random quantities, interleaved best first: bid 0, ask 0, bid 1, ask 1, ... */
export function buildLadder(fair: number, profile: MakerProfile, size: SizeRange, rng: Rng): Quote[] {
    const { bids, asks } = ladderPrices(fair, profile);
    const quantity = (level: number): number =>
        Math.max(1, Math.round(uniform(rng, size.min, size.max) * profile.sizeFactor * (1 + 0.15 * level)));
    const quotes: Quote[] = [];
    for (let level = 0; level < Math.max(bids.length, asks.length); level++) {
        const bid = bids[level];
        if (bid !== undefined) {
            quotes.push({ side: 'BUY', price: bid, quantity: quantity(level) });
        }
        const ask = asks[level];
        if (ask !== undefined) {
            quotes.push({ side: 'SELL', price: ask, quantity: quantity(level) });
        }
    }
    return quotes;
}

/**
 * True if a new order would meet one of the maker's own orders: a buy at or above its lowest sell,
 * or a sell at or below its highest buy. Such an order would trade with the maker itself.
 */
export function crossesOwn(side: Side, price: number, own: Iterable<{ side: Side; price: number }>): boolean {
    for (const order of own) {
        if (side === 'BUY' && order.side === 'SELL' && price >= order.price) {
            return true;
        }
        if (side === 'SELL' && order.side === 'BUY' && price <= order.price) {
            return true;
        }
    }
    return false;
}

export interface RequoteInput {
    fair: number;
    profile: MakerProfile;
    size: SizeRange;
    live: readonly LiveOrder[];
    now: number;
    rng: Rng;
    maxOrders: number;
}

export interface RequotePlan {
    /** Orders to cancel: expired, on the wrong side of the fair price, or too far from it. */
    cancel: LiveOrder[];
    /** New orders for the missing levels, best first. None of them crosses an order that stays. */
    place: Quote[];
}

/** Orders farther than this beyond the outermost level are canceled. */
const FAR_MARGIN = 0.006;

/**
 * Decides what one requote of one maker in one market does. Pure: the caller performs the plan,
 * checking `crossesOwn` again before every placement in case a cancel failed.
 */
export function planRequote(input: RequoteInput): RequotePlan {
    const { fair, profile, size, live, now, rng, maxOrders } = input;
    const target = buildLadder(fair, profile, size, rng);
    const { bids, asks } = ladderPrices(fair, profile);
    const outer = profile.firstOffset + (profile.levels - 1) * profile.spacing + FAR_MARGIN;

    // A bid above the new best bid is too aggressive (the fair price fell), one far below the ladder is useless.
    // The same for asks. At least two credits of slack keep cheap items from churning on rounding.
    const highestBid = bids[0] ?? Math.ceil(fair) - 1;
    const lowestBid = Math.min(Math.floor(fair * (1 - outer)), (bids.at(-1) ?? highestBid) - 2);
    const lowestAsk = asks[0] ?? Math.floor(fair) + 1;
    const highestAsk = Math.max(Math.ceil(fair * (1 + outer)), (asks.at(-1) ?? lowestAsk) + 2);

    const cancel: LiveOrder[] = [];
    let kept: LiveOrder[] = [];
    for (const order of live) {
        const stale =
            now >= order.expiresAt ||
            (order.side === 'BUY' ? order.price > highestBid || order.price < lowestBid : order.price < lowestAsk || order.price > highestAsk);
        (stale ? cancel : kept).push(order);
    }

    // More orders than allowed (for example adopted after a refresh): drop those farthest from fair
    if (kept.length > maxOrders) {
        kept.sort((a, b) => Math.abs(a.price - fair) - Math.abs(b.price - fair));
        cancel.push(...kept.slice(maxOrders));
        kept = kept.slice(0, maxOrders);
    }

    // A level is covered by a kept order of the same side within half a spacing; each order covers one level
    const tolerance = (fair * profile.spacing) / 2;
    const unmatched = [...kept];
    const missing: Quote[] = [];
    for (const quote of target) {
        let best = -1;
        for (let i = 0; i < unmatched.length; i++) {
            const order = unmatched[i]!;
            const distance = Math.abs(order.price - quote.price);
            if (order.side === quote.side && distance <= tolerance && (best < 0 || distance < Math.abs(unmatched[best]!.price - quote.price))) {
                best = i;
            }
        }
        if (best >= 0) {
            unmatched.splice(best, 1);
        } else {
            missing.push(quote);
        }
    }

    const place: Quote[] = [];
    for (const quote of missing) {
        if (kept.length + place.length >= maxOrders) {
            break;
        }
        if (crossesOwn(quote.side, quote.price, kept) || crossesOwn(quote.side, quote.price, place)) {
            continue;
        }
        place.push(quote);
    }
    return { cancel, place };
}
