import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import { MAKER_FUNDS, planGrant, TAKER_FUNDS } from '../src/funds.js';
import { anchorFor } from '../src/markets.js';

const markets = [
    { id: 1, expensive: false },
    { id: 2, expensive: true },
];

test('no grant while everything is above its threshold', () => {
    const grant = planGrant(
        MAKER_FUNDS,
        { available: 2_500_000, reserved: 0 },
        { fungible: [{ marketId: 1, defId: 'coal', available: 400, reserved: 50 }, { marketId: 2, defId: 'crystal', available: 60, reserved: 0 }] },
        markets,
    );
    assert.equal(grant, null);
});

test('one grant tops up credits and every item below its threshold', () => {
    const grant = planGrant(
        MAKER_FUNDS,
        { available: 1_000, reserved: 90_000 },
        { fungible: [{ marketId: 1, defId: 'coal', available: 299, reserved: 0 }] },
        markets,
    );
    assert.deepEqual(grant, {
        credits: 3_000_000,
        items: [
            { marketId: 1, quantity: 900 - 299 },
            { marketId: 2, quantity: 150 },
        ],
    });
    const taker = planGrant(TAKER_FUNDS, { available: 300_000, reserved: 0 }, { fungible: [{ marketId: 2, defId: 'crystal', available: 10, reserved: 0 }] }, markets);
    assert.deepEqual(taker, { credits: 0, items: [{ marketId: 1, quantity: 144 }, { marketId: 2, quantity: 62 }] });
});

test('the anchor is the last price, a catalog default, or 100', () => {
    assert.equal(anchorFor({ defId: 'iron_ore', lastPrice: 312 }), 312);
    assert.equal(anchorFor({ defId: 'iron_ore', lastPrice: null }), 300);
    assert.equal(anchorFor({ defId: 'coal', lastPrice: null }), 120);
    assert.equal(anchorFor({ defId: 'crystal', lastPrice: null }), 2_500);
    assert.equal(anchorFor({ defId: 'gold_bar', lastPrice: null }), 100);
    assert.equal(anchorFor({ defId: 'gold_bar', lastPrice: 7_777 }), 7_777);
    // A stray trade must not move a catalog item's anchor arbitrarily far
    assert.equal(anchorFor({ defId: 'coal', lastPrice: 1 }), 60);
    assert.equal(anchorFor({ defId: 'crystal', lastPrice: 1_000_000 }), 5_000);
});

test('configuration comes from the environment with defaults', () => {
    assert.deepEqual(loadConfig({ INTERNAL_TOKEN: 'secret' }), {
        coreUrl: 'http://localhost:8080',
        internalToken: 'secret',
        makers: 2,
        takers: 3,
        ordersPerSecond: 2,
        logLevel: 'info',
    });
    const custom = loadConfig({
        INTERNAL_TOKEN: 's',
        CORE_URL: 'http://core:8080/',
        BOT_MAKERS: '1',
        BOT_TAKERS: '0',
        BOT_ORDERS_PER_SECOND: '0.5',
        LOG_LEVEL: 'DEBUG',
    });
    assert.equal(custom.coreUrl, 'http://core:8080');
    assert.equal(custom.ordersPerSecond, 0.5);
    assert.equal(custom.logLevel, 'debug');
    assert.throws(() => loadConfig({}), ConfigError);
    assert.throws(() => loadConfig({ INTERNAL_TOKEN: 's', BOT_MAKERS: '1.5' }), ConfigError);
    assert.throws(() => loadConfig({ INTERNAL_TOKEN: 's', BOT_ORDERS_PER_SECOND: '0' }), ConfigError);
    assert.throws(() => loadConfig({ INTERNAL_TOKEN: 's', CORE_URL: 'core:8080' }), ConfigError);
    assert.throws(() => loadConfig({ INTERNAL_TOKEN: 's', LOG_LEVEL: 'verbose' }), ConfigError);
});
