import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenBucket } from '../src/rate-limiter.js';

test('a burst up to the capacity passes, then one request per 1/rate seconds', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 2, () => now);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), false, 'the burst is used up');

    now += 499;
    assert.equal(bucket.tryTake(), false, 'half a second has not passed yet');
    now += 1;
    assert.equal(bucket.tryTake(), true, 'one token after 1/rate seconds');
    assert.equal(bucket.tryTake(), false);

    now += 60_000;
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), true);
    assert.equal(bucket.tryTake(), false, 'a long idle time saves up no more than the capacity');
});

test('concurrent callers of take() are spread out to the rate', async () => {
    const rate = 50;
    const bucket = new TokenBucket(rate, 1);
    const started = performance.now();
    const times: number[] = [];
    await Promise.all(
        Array.from({ length: 26 }, () => bucket.take().then(() => times.push(performance.now() - started))),
    );
    const elapsed = performance.now() - started;
    // One token at once, the other 25 at 50 per second: half a second at least
    assert.ok(elapsed >= 480, `26 tokens took only ${elapsed.toFixed(0)} ms`);
    assert.ok(elapsed < 1_500, `26 tokens took ${elapsed.toFixed(0)} ms, far more than needed`);
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
        // Never more than one token ahead of the schedule (timers may fire a little late, never early)
        assert.ok(times[i]! >= ((i - 1) * 1000) / rate - 5, `token ${i} came at ${times[i]!.toFixed(0)} ms`);
    }
});

test('waiters are served first come, first served', async () => {
    const bucket = new TokenBucket(100, 1);
    bucket.tryTake();
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => bucket.take().then(() => order.push(n))));
    assert.deepEqual(order, [1, 2, 3, 4]);
});

test('an aborted waiter leaves the queue and does not use up a token', async () => {
    const bucket = new TokenBucket(1, 1);
    assert.equal(bucket.tryTake(), true);
    const controller = new AbortController();
    const waiting = bucket.take(controller.signal);
    assert.equal(bucket.waiting, 1);
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(bucket.waiting, 0);
    await assert.rejects(bucket.take(controller.signal), { name: 'AbortError' }, 'an aborted signal is refused at once');
});
