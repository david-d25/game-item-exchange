import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Backoff, backoffCeiling, backoffDelay } from '../src/backoff.js';
import { seededRng } from '../src/random.js';

const options = { baseMs: 100, maxMs: 5_000 };

test('the backoff ceiling doubles with every attempt and stops at the cap', () => {
    const ceilings = Array.from({ length: 10 }, (_, attempt) => backoffCeiling(attempt, options));
    assert.deepEqual(ceilings, [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000, 5_000, 5_000]);
    assert.equal(backoffCeiling(10_000, options), 5_000, 'huge attempt numbers must not overflow');
});

test('every delay lies between half the ceiling and the ceiling', () => {
    const rng = seededRng(1);
    for (let attempt = 0; attempt < 40; attempt++) {
        const ceiling = backoffCeiling(attempt, options);
        for (let i = 0; i < 50; i++) {
            const delay = backoffDelay(attempt, options, rng);
            assert.ok(delay >= ceiling / 2 && delay <= ceiling, `attempt ${attempt}: ${delay} outside [${ceiling / 2}, ${ceiling}]`);
        }
    }
    // The extremes of the jitter
    assert.equal(backoffDelay(3, options, () => 0), 400);
    assert.equal(backoffDelay(3, options, () => 0.999999), 799.9996);
});

test('consecutive failures back off longer and longer, up to the cap, and reset starts over', () => {
    const backoff = new Backoff(options, seededRng(7));
    const delays = Array.from({ length: 12 }, () => backoff.next());
    // With equal jitter each delay is at least the previous ceiling, so the sequence never shrinks before the cap
    for (let i = 1; i <= 6; i++) {
        assert.ok(delays[i]! >= delays[i - 1]!, `delay ${i} (${delays[i]}) is shorter than delay ${i - 1} (${delays[i - 1]})`);
    }
    assert.ok(delays[6]! > 10 * delays[0]!, 'the delay grows by an order of magnitude');
    for (const delay of delays) {
        assert.ok(delay <= options.maxMs, `delay ${delay} exceeds the cap`);
    }
    for (const delay of delays.slice(7)) {
        assert.ok(delay >= options.maxMs / 2, 'once capped, the delay stays near the cap');
    }
    assert.equal(backoff.failures, 12);

    backoff.reset();
    assert.equal(backoff.failures, 0);
    assert.ok(backoff.next() <= options.baseMs);
});
