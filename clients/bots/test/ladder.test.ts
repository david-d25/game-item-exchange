import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Side } from '../src/api.js';
import { buildLadder, crossesOwn, ladderPrices, planRequote, randomProfile, type LiveOrder, type MakerProfile } from '../src/ladder.js';
import { randomInt, seededRng, uniform } from '../src/random.js';

const profile: MakerProfile = { levels: 4, firstOffset: 0.005, spacing: 0.005, sizeFactor: 1 };

test('ladder prices are whole, at least 1, strictly ordered and on the right side of fair', () => {
    const rng = seededRng(3);
    const fairs = [0.62, 1, 1.4, 2, 3, 7.5, 50, 120, 300, 2_500, 1e6];
    for (let i = 0; i < 500; i++) {
        fairs.push(Math.exp(uniform(rng, Math.log(0.62), Math.log(1e6))));
    }
    for (const fair of fairs) {
        const p = randomProfile(rng);
        const { bids, asks } = ladderPrices(fair, p);
        for (const price of [...bids, ...asks]) {
            assert.ok(Number.isInteger(price) && price >= 1, `fair ${fair}: price ${price}`);
        }
        for (let i = 1; i < bids.length; i++) {
            assert.ok(bids[i]! < bids[i - 1]!, `fair ${fair}: bids not strictly falling: ${bids}`);
        }
        for (let i = 1; i < asks.length; i++) {
            assert.ok(asks[i]! > asks[i - 1]!, `fair ${fair}: asks not strictly rising: ${asks}`);
        }
        if (bids.length > 0) {
            assert.ok(bids[0]! < fair, `fair ${fair}: best bid ${bids[0]} is not below fair`);
        }
        assert.ok(asks[0]! > fair, `fair ${fair}: best ask ${asks[0]} is not above fair`);
        assert.equal(asks.length, p.levels);
        if (fair >= 20) {
            assert.equal(bids.length, p.levels, `fair ${fair}: missing bid levels`);
        }
    }
});

test('a typical ladder has its best level 0.3-1% from fair and the next ones 0.3-0.8% apart', () => {
    const { bids, asks } = ladderPrices(2_500, profile);
    assert.deepEqual(bids, [2487, 2475, 2462, 2450]);
    assert.deepEqual(asks, [2513, 2525, 2538, 2550]);
    // Cheap items: percentages below one credit still give distinct levels
    const cheap = ladderPrices(120, profile);
    assert.deepEqual(cheap.bids, [119, 118, 117, 116]);
    assert.deepEqual(cheap.asks, [121, 122, 123, 124]);
});

test('quantities stay within the size range scaled by the maker and are whole numbers', () => {
    const rng = seededRng(11);
    for (let i = 0; i < 200; i++) {
        const p = randomProfile(rng);
        for (const quote of buildLadder(300, p, { min: 1, max: 3 }, rng)) {
            assert.ok(Number.isInteger(quote.quantity) && quote.quantity >= 1 && quote.quantity <= 3 * 1.3 * 1.6 + 1);
        }
    }
});

test('two makers do not quote the same ladder', () => {
    const rng = seededRng(21);
    const a = randomProfile(rng);
    const b = randomProfile(rng);
    assert.notDeepEqual(ladderPrices(300, a), ladderPrices(300, b));
});

test('crossesOwn detects buys at or above own sells and sells at or below own buys', () => {
    const own = [
        { side: 'BUY' as Side, price: 100 },
        { side: 'SELL' as Side, price: 105 },
    ];
    assert.equal(crossesOwn('BUY', 104, own), false);
    assert.equal(crossesOwn('BUY', 105, own), true);
    assert.equal(crossesOwn('BUY', 200, own), true);
    assert.equal(crossesOwn('SELL', 101, own), false);
    assert.equal(crossesOwn('SELL', 100, own), true);
    assert.equal(crossesOwn('SELL', 1, own), true);
    assert.equal(crossesOwn('SELL', 1, []), false);
});

test('a requote never self-crosses, keeps prices >= 1 and respects the order limit', () => {
    const rng = seededRng(42);
    const maxOrders = 10;
    for (let iteration = 0; iteration < 5_000; iteration++) {
        const fair = Math.exp(uniform(rng, Math.log(0.62), Math.log(20_000)));
        const p = randomProfile(rng);
        const now = 1_000_000;
        // Arbitrary existing orders: some old, some on the wrong side, some far away, some crossing each other
        const live: LiveOrder[] = Array.from({ length: randomInt(rng, 0, 14) }, (_, i) => ({
            orderId: i + 1,
            side: rng() < 0.5 ? 'BUY' : 'SELL',
            price: Math.max(1, Math.round(fair * uniform(rng, 0.9, 1.1))),
            quantity: randomInt(rng, 1, 10),
            filled: 0,
            placedAt: now - 10_000,
            expiresAt: now + uniform(rng, -5_000, 60_000),
        }));
        const plan = planRequote({ fair, profile: p, size: { min: 1, max: 40 }, live, now, rng, maxOrders });

        const canceled = new Set(plan.cancel.map((o) => o.orderId));
        const kept = live.filter((o) => !canceled.has(o.orderId));
        for (const quote of plan.place) {
            assert.ok(Number.isInteger(quote.price) && quote.price >= 1, `price ${quote.price}`);
            assert.ok(Number.isInteger(quote.quantity) && quote.quantity >= 1, `quantity ${quote.quantity}`);
            assert.ok(quote.side === 'BUY' ? quote.price < fair : quote.price > fair, `${quote.side} at ${quote.price} with fair ${fair}`);
            const others = [...kept, ...plan.place.filter((q) => q !== quote)];
            assert.equal(crossesOwn(quote.side, quote.price, others), false, `${quote.side} at ${quote.price} crosses an own order (fair ${fair})`);
        }
        for (const order of kept) {
            assert.ok(order.expiresAt > now, 'expired orders are canceled');
        }
        assert.ok(kept.length + plan.place.length <= maxOrders, `${kept.length} kept + ${plan.place.length} new orders`);
    }
});

test('a requote replaces stale orders and leaves good ones alone', () => {
    const now = 100_000;
    const order = (orderId: number, side: Side, price: number, expiresAt = now + 30_000): LiveOrder => ({
        orderId,
        side,
        price,
        quantity: 5,
        filled: 0,
        placedAt: now - 1_000,
        expiresAt,
    });
    // Ladder at fair 300: bids 298 296 295 293, asks 302 304 305 307
    const live = [
        order(1, 'BUY', 298), // fine
        order(2, 'SELL', 302), // fine
        order(3, 'BUY', 296, now - 1), // expired
        order(4, 'BUY', 301), // above fair: the fair price has fallen
        order(5, 'SELL', 299), // below fair
        order(6, 'SELL', 400), // far away
        order(7, 'BUY', 200), // far away
    ];
    const plan = planRequote({ fair: 300, profile, size: { min: 5, max: 5 }, live, now, rng: seededRng(1), maxOrders: 10 });
    assert.deepEqual(plan.cancel.map((o) => o.orderId).sort(), [3, 4, 5, 6, 7]);
    const placed = plan.place.map((q) => `${q.side} ${q.price}`);
    assert.ok(!placed.includes('BUY 298') && !placed.includes('SELL 302'), 'covered levels are not placed again');
    assert.equal(plan.place.length, 6, `placed: ${placed.join(', ')}`);
});

test('a new order is skipped while an own order that would cross it is still in the book', () => {
    const now = 0;
    // The fair price jumped from 300 to 330. A sell at 305 is stale, but suppose its cancel failed:
    // the caller keeps it, and the plan computed without it must be re-checked with crossesOwn.
    const stuck: LiveOrder = { orderId: 1, side: 'SELL', price: 305, quantity: 1, filled: 0, placedAt: 0, expiresAt: 1e9 };
    const plan = planRequote({ fair: 330, profile, size: { min: 1, max: 1 }, live: [stuck], now, rng: seededRng(2), maxOrders: 10 });
    assert.deepEqual(plan.cancel, [stuck]);
    const crossing = plan.place.filter((q) => crossesOwn(q.side, q.price, [stuck]));
    assert.ok(crossing.length > 0 && crossing.every((q) => q.side === 'BUY'), 'the bids at about 328 would cross the stuck sell');
});
