import type { Grant, Inventory, Wallet } from './api.js';

export interface FundsPolicy {
    /** Below this many available credits the bot gets a top-up... */
    minCredits: number;
    /** ...of this many credits. */
    creditsTopUp: number;
    /** Below this many available items of a market the bot gets items... */
    minItems(market: { expensive: boolean }): number;
    /** ...up to this many. */
    itemsTarget(market: { expensive: boolean }): number;
}

/** Makers keep ladders on both sides of every market, so they hold a lot of both. */
export const MAKER_FUNDS: FundsPolicy = {
    minCredits: 2_000_000,
    creditsTopUp: 3_000_000,
    minItems: (market) => (market.expensive ? 50 : 300),
    itemsTarget: (market) => (market.expensive ? 150 : 900),
};

/** Takers trade small amounts. */
export const TAKER_FUNDS: FundsPolicy = {
    minCredits: 300_000,
    creditsTopUp: 700_000,
    minItems: (market) => (market.expensive ? 24 : 48),
    itemsTarget: (market) => (market.expensive ? 72 : 144),
};

/** One grant request with everything that is below its threshold, or null if nothing is. */
export function planGrant(
    policy: FundsPolicy,
    wallet: Wallet,
    inventory: Inventory,
    markets: readonly { id: number; expensive: boolean }[],
): Grant | null {
    const credits = wallet.available < policy.minCredits ? policy.creditsTopUp : 0;
    const held = new Map<number, number>();
    for (const holding of inventory.fungible) {
        held.set(holding.marketId, holding.available);
    }
    const items: Grant['items'] = [];
    for (const market of markets) {
        const available = held.get(market.id) ?? 0;
        if (available < policy.minItems(market)) {
            items.push({ marketId: market.id, quantity: policy.itemsTarget(market) - available });
        }
    }
    return credits === 0 && items.length === 0 ? null : { credits, items };
}
