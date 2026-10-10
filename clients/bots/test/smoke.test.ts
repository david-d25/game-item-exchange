import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { BotApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { DEFAULT_PRICE_WALK } from '../src/price.js';
import { sleep } from '../src/sleep.js';
import type { Tuning } from '../src/tuning.js';
import { FakeCore, type FakeMarket } from './fake-core.js';

const TOKEN = 'test-internal-token';

// Ids are deliberately not 1, 2, 3: the bots must take them from GET /markets
const IRON: FakeMarket = { marketId: 7, gameId: 'idle-mine', defId: 'iron_ore', name: 'Iron ore', kind: 'FUNGIBLE', lastPrice: 305 };
const COAL: FakeMarket = { marketId: 9, gameId: 'idle-mine', defId: 'coal', name: 'Coal', kind: 'FUNGIBLE', lastPrice: null };
const CRYSTAL: FakeMarket = { marketId: 11, gameId: 'idle-mine', defId: 'crystal', name: 'Crystal', kind: 'FUNGIBLE', lastPrice: null };
const PICKAXE: FakeMarket = { marketId: 13, gameId: 'idle-mine', defId: 'golden_pickaxe', name: 'Golden pickaxe', kind: 'UNIQUE', lastPrice: null };
const GOLD: FakeMarket = { marketId: 42, gameId: 'idle-mine', defId: 'gold_bar', name: 'Gold bar', kind: 'FUNGIBLE', lastPrice: null };

/** Everything about ten times faster than in production, and a much more nervous price. */
const FAST: Partial<Tuning> = {
    fairUpdateMs: 100,
    marketsRefreshMs: 1_000,
    requoteMinMs: 250,
    requoteMaxMs: 700,
    orderLifetimeMinMs: 1_500,
    orderLifetimeMaxMs: 2_500,
    takerMeanIntervalMs: 150,
    sweepMeanIntervalMs: 800,
    fillCheckDelayMs: 100,
    fundsCheckMs: 1_500,
    fundsCheckMinGapMs: 300,
    summaryMs: 2_000,
    readinessMaxDelayMs: 200,
    requestTimeoutMs: 2_000,
    // Moves of several percent within seconds, so that requotes really have to cancel and replace
    priceWalk: { ...DEFAULT_PRICE_WALK, sigmaPerMinute: 0.08, jumpsPerHour: 600, jumpSigma: 0.03 },
};

function config(core: FakeCore, overrides: Partial<Config> = {}): Config {
    return { coreUrl: core.url, internalToken: TOKEN, makers: 2, takers: 3, ordersPerSecond: 300, logLevel: 'debug', ...overrides };
}

/** Runs the test body; on failure prints the end of the bots' log, which is otherwise kept quiet. */
async function withLogs(t: TestContext, body: (lines: string[]) => Promise<void>): Promise<void> {
    const lines: string[] = [];
    try {
        await body(lines);
    } catch (error) {
        for (const line of lines.slice(-80)) {
            t.diagnostic(line);
        }
        throw error;
    }
}

test('bots keep a live two-sided market and clean up after themselves', { timeout: 60_000 }, async (t) => {
    const core = new FakeCore({ internalToken: TOKEN, markets: [IRON, COAL, CRYSTAL, PICKAXE], notReadyFor: 2, faultRate: 0.03 });
    await core.start();
    t.after(() => core.stop());

    // Orders of a previous run. The sell at 250 is below the fair price of iron ore: had it not been
    // canceled before quoting started, the first bids of maker-1 would have traded with it.
    const leftovers = [core.seedRestingOrder('maker-1', IRON.marketId, 'SELL', 250, 1), core.seedRestingOrder('maker-2', COAL.marketId, 'BUY', 1, 3)];

    await withLogs(t, async (lines) => {
        const app = new BotApp({ config: config(core), tuning: FAST, log: createLogger('debug', 'bots', (line) => lines.push(line)) });
        const running = app.run();

        await sleep(3_000);
        core.addMarket(GOLD); // new markets are picked up while running
        await sleep(2_000);
        const revokedAt = core.now();
        core.revokeAllTokens(); // every bot gets 401 and must sign in again
        await sleep(5_000);

        core.faultRate = 0;
        const placedBeforeStop = core.orderRequests.length;
        await app.stop('end of test');
        await running;
        await core.idle();

        const names = ['maker-1', 'maker-2', 'taker-1', 'taker-2', 'taker-3'];
        const bots = names.map((name) => core.userByName(name));
        assert.ok(bots.every((user) => user !== undefined), 'all bot users were created');
        const makerIds = new Set([bots[0]!.userId, bots[1]!.userId]);
        const botIds = new Set(bots.map((user) => user!.userId));
        const orders = [...core.orders.values()];

        // Both sides of every fungible market, including the one that appeared later
        for (const market of [IRON, COAL, CRYSTAL, GOLD]) {
            for (const side of ['BUY', 'SELL'] as const) {
                const count = orders.filter((o) => o.marketId === market.marketId && o.side === side && makerIds.has(o.ownerId)).length;
                assert.ok(count > 0, `makers placed no ${side} orders in ${market.defId}`);
            }
        }
        assert.equal(orders.filter((o) => o.marketId === PICKAXE.marketId).length, 0, 'unique markets are left alone');

        // Trades happened, in every original market, and also after all tokens were revoked
        for (const market of [IRON, COAL, CRYSTAL]) {
            assert.ok(core.trades.some((trade) => trade.marketId === market.marketId), `no trades in ${market.defId}`);
        }
        assert.ok(core.trades.length >= 30, `only ${core.trades.length} trades`);
        assert.ok(core.trades.some((trade) => trade.at > revokedAt + 500), 'trading went on after the tokens were revoked');
        assert.ok(core.tokensIssued >= 2 * names.length, `tokens issued: ${core.tokensIssued}`);

        // No maker ever met its own order, no maker ever had crossing orders
        assert.deepEqual(core.violations, []);

        // Requests were well-formed and every retry reused its clientOrderId
        assert.equal(core.problems.get('invalid-request') ?? 0, 0, 'malformed requests');
        assert.equal(core.problems.get('client-order-id-reused') ?? 0, 0, 'reused clientOrderIds');

        // Leftovers were canceled at startup, and nothing is left in the book after the shutdown
        for (const leftover of leftovers) {
            assert.equal(leftover.closeReason, 'CANCELED', `leftover order ${leftover.orderId} is ${leftover.status}`);
        }
        const stillActive = orders.filter((o) => botIds.has(o.ownerId) && o.status !== 'CLOSED');
        assert.deepEqual(
            stillActive.map((o) => `${o.orderId} ${o.side} @ ${o.price} in ${o.marketId}`),
            [],
            'the shutdown must cancel every open order',
        );
        assert.ok(core.orderRequests.length > placedBeforeStop, 'the shutdown sent cancel requests');

        // The bots topped themselves up, requoted, swept, and counted what they saw
        assert.ok(core.grants.length >= names.length, `grants: ${core.grants.length}`);
        const totals = app.stats.totals();
        assert.ok(totals.placed > 100 && totals.canceled > 20 && totals.fills > 10, `stats: ${JSON.stringify(totals)}`);
        assert.ok(totals.sweeps >= 1, 'at least one sweep');
        assert.ok(lines.some((line) => line.includes('] last ') && line.includes('placed')), 'a periodic summary was logged');
    });
});

test('order and cancel requests of all bots together respect BOT_ORDERS_PER_SECOND', { timeout: 30_000 }, async (t) => {
    const core = new FakeCore({ internalToken: TOKEN, markets: [IRON, COAL, CRYSTAL] });
    await core.start();
    t.after(() => core.stop());

    await withLogs(t, async (lines) => {
        const rate = 8;
        const app = new BotApp({
            config: config(core, { ordersPerSecond: rate }),
            tuning: FAST,
            log: createLogger('debug', 'bots', (line) => lines.push(line)),
        });
        const running = app.run();
        await sleep(4_000);
        const requests = core.orderRequests.map((r) => r.at);
        await app.stop('end of test');
        await running;

        assert.ok(requests.length >= 2 * rate, `the bots were nearly idle: ${requests.length} requests`);
        // A token bucket lets through its capacity (one second's worth) at once, then `rate` per second
        for (let i = 0; i < requests.length; i++) {
            const inWindow = requests.filter((at) => at >= requests[i]! && at < requests[i]! + 1_000).length;
            assert.ok(inWindow <= 2 * rate + 1, `${inWindow} order requests within one second, limit ${rate}/s`);
        }
        const span = (requests.at(-1)! - requests[0]!) / 1000;
        assert.ok(requests.length <= rate + rate * span + 2, `${requests.length} requests in ${span.toFixed(1)} s`);
    });
});

test('dist main.js runs from the environment and exits with 0 after canceling on SIGTERM', { timeout: 30_000 }, async (t) => {
    const core = new FakeCore({ internalToken: TOKEN, markets: [IRON, COAL, CRYSTAL] });
    await core.start();
    t.after(() => core.stop());

    const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
    const child = spawn(process.execPath, [main], {
        env: {
            ...process.env,
            CORE_URL: core.url,
            INTERNAL_TOKEN: TOKEN,
            BOT_MAKERS: '1',
            BOT_TAKERS: '1',
            BOT_ORDERS_PER_SECOND: '100',
            LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;

    try {
        // Wait until the maker has a ladder up
        const deadline = performance.now() + 15_000;
        let resting = 0;
        while (performance.now() < deadline) {
            const maker = core.userByName('maker-1');
            resting = maker ? core.ordersOf(maker.userId).filter((o) => o.status === 'OPEN').length : 0;
            if (resting >= 8) {
                break;
            }
            await sleep(100);
        }
        assert.ok(resting >= 8, `the maker has only ${resting} resting orders`);

        const stoppedAt = performance.now();
        child.kill('SIGTERM');
        const [code, signal] = await exited;
        const took = performance.now() - stoppedAt;
        await core.idle();

        assert.equal(signal, null);
        assert.equal(code, 0);
        assert.ok(took < 6_500, `the shutdown took ${took.toFixed(0)} ms`);
        for (const name of ['maker-1', 'taker-1']) {
            const user = core.userByName(name)!;
            const open = core.ordersOf(user.userId).filter((o) => o.status !== 'CLOSED');
            assert.equal(open.length, 0, `${name} still has ${open.length} open orders`);
        }
        const log = output.join('');
        assert.match(log, /\[maker-1\] signed in as user \d+/);
        assert.match(log, /stopping \(SIGTERM\)/);
        assert.match(log, /stopped in \d+ ms: canceled \d+ open orders/);
    } catch (error) {
        child.kill('SIGKILL');
        t.diagnostic(output.join('').split('\n').slice(-40).join('\n'));
        throw error;
    }
});
