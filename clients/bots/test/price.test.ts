import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PRICE_WALK, FairPrice, reflect } from '../src/price.js';
import { seededRng } from '../src/random.js';

const STEP_SECONDS = 3;
const steps = (hours: number): number => Math.round((hours * 3600) / STEP_SECONDS);

test('the fair price stays within 0.62..1.6 of the anchor over a simulated week', () => {
    for (let seed = 1; seed <= 4; seed++) {
        const fair = new FairPrice(300, DEFAULT_PRICE_WALK, seededRng(seed));
        let low = Infinity;
        let high = -Infinity;
        for (let i = 0; i < steps(24 * 7); i++) {
            fair.step(STEP_SECONDS);
            low = Math.min(low, fair.ratio);
            high = Math.max(high, fair.ratio);
            assert.ok(Number.isInteger(fair.price) && fair.price >= 1);
        }
        assert.ok(low >= 0.62 && high <= 1.6, `seed ${seed}: ratio went to ${low.toFixed(3)}..${high.toFixed(3)}`);
        // It does move, though
        assert.ok(high - low > 0.05, `seed ${seed}: the price barely moved (${low.toFixed(3)}..${high.toFixed(3)})`);
    }
});

test('the bounds hold even for a wild walk, and the price is a whole number of at least 1', () => {
    const wild = { ...DEFAULT_PRICE_WALK, sigmaPerMinute: 0.2, jumpsPerHour: 120, jumpSigma: 0.5 };
    const fair = new FairPrice(1, wild, seededRng(99));
    let touchedLow = false;
    let touchedHigh = false;
    for (let i = 0; i < 20_000; i++) {
        fair.step(STEP_SECONDS);
        assert.ok(fair.ratio >= 0.62 - 1e-12 && fair.ratio <= 1.6 + 1e-12, `ratio ${fair.ratio}`);
        assert.ok(fair.price >= 1);
        touchedLow ||= fair.ratio < 0.65;
        touchedHigh ||= fair.ratio > 1.5;
    }
    assert.ok(touchedLow && touchedHigh, 'the wild walk should reach both walls');
    assert.equal(reflect(Number.NaN, -1, 1), 0);
    assert.equal(reflect(-1.2, -1, 1), -0.8);
    assert.equal(reflect(1.5, -1, 1), 0.5);
});

test('the fair price reverts to the anchor', () => {
    // Start at 1.5x the anchor. The half-life is 6 hours: after 6 hours about half of the excursion is left,
    // after 24 hours about a sixteenth.
    const runs = 40;
    let after6h = 0;
    let after24h = 0;
    for (let run = 0; run < runs; run++) {
        const fair = new FairPrice(1_000, DEFAULT_PRICE_WALK, seededRng(1_000 + run), 1.5);
        for (let i = 0; i < steps(6); i++) {
            fair.step(STEP_SECONDS);
        }
        after6h += Math.log(fair.ratio) / runs;
        for (let i = 0; i < steps(18); i++) {
            fair.step(STEP_SECONDS);
        }
        after24h += Math.log(fair.ratio) / runs;
    }
    const start = Math.log(1.5);
    assert.ok(after6h > start * 0.3 && after6h < start * 0.7, `after 6 h: ${after6h.toFixed(3)}, expected about ${(start / 2).toFixed(3)}`);
    assert.ok(Math.abs(after24h) < start * 0.2, `after 24 h: ${after24h.toFixed(3)}, expected about ${(start / 16).toFixed(3)}`);
});

test('the 1-minute chart moves by a few tenths of a percent', () => {
    const fair = new FairPrice(300, DEFAULT_PRICE_WALK, seededRng(5));
    const changes: number[] = [];
    let previous = Math.log(fair.value);
    for (let minute = 0; minute < 3 * 24 * 60; minute++) {
        for (let i = 0; i < 60 / STEP_SECONDS; i++) {
            fair.step(STEP_SECONDS);
        }
        const current = Math.log(fair.value);
        changes.push(current - previous);
        previous = current;
    }
    const mean = changes.reduce((sum, x) => sum + x, 0) / changes.length;
    const sd = Math.sqrt(changes.reduce((sum, x) => sum + (x - mean) ** 2, 0) / changes.length);
    assert.ok(sd > 0.003 && sd < 0.008, `standard deviation of 1-minute moves is ${(sd * 100).toFixed(3)}%`);
    const big = changes.filter((x) => Math.abs(x) > 0.02).length;
    assert.ok(big > 0, 'there are occasional larger swings');
});
