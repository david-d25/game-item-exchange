# Trading bots

Bots that trade play money around the clock, so that anyone who opens the site sees a live market: a moving
price chart, a full order book on both sides and a steady stream of trades. They also put a steady load on
core for the Grafana dashboards.

The bots are an ordinary client. They use only the public HTTP API and two internal endpoints
(`POST /internal/v1/bots`, `POST /internal/v1/users/{id}/grants`) from [docs/api.md](../../docs/api.md).
They have no runtime dependencies and run on about 65 MB of resident memory (measured on Node 22).

## What they do

**Fair price.** Each fungible market has one fair price that all bots share. It is a random walk on the log
price that is pulled back to an anchor (an Ornstein–Uhlenbeck process) and updated every 3 s. The 1-minute chart
moves by about 0.4% per minute, a jump of about 1.5% comes every 20 minutes or so, and an excursion halves in
about 6 hours. The price never leaves 0.62–1.6 × the anchor. The anchor is the market's `lastPrice` at
startup, or 300 / 120 / 2 500 for iron ore / coal / crystal, or 100 for any other item.

**Makers** (`maker-1`, `maker-2`, …) keep a ladder of GTC orders on both sides of every market. Each maker
gets its own random profile: 3–5 levels per side, the best level 0.3–1% from fair, levels 0.3–0.8% apart,
and its own quantity scale. Quantities are random within 1–3 for crystals, 3–25 for iron ore and 5–40 for coal.
Every 8–20 s per market a maker:

1. reads its active orders in that market (`GET /me/orders?status=ACTIVE&marketId=`), so that levels taken by
   others are replaced at once;
2. cancels orders that are older than their 60–90 s lifetime, on the wrong side of the new fair price, or far
   beyond the ladder;
3. places the missing levels, best first, with at most 10 active orders per market.

A maker never places a buy at or above its own lowest active sell, or a sell at or below its own highest
active buy. Its own orders include any whose cancel failed.

**Takers** (`taker-1` … `taker-3`) act at random moments (exponential, 5 s mean per taker). A taker picks a
market and reads the book (`depth=10`). It picks a side, leaning toward the one that pulls the mid price back
to fair: 1% below fair gives a 75% chance of buying. It then sends an IOC order at the best opposite price for
a small quantity. It skips the trade if that side is empty or the price is more than 5% from fair, so a stray
order from a human is never taken at any price. About once every 3 minutes, counting all takers, one taker
sweeps 2–3 levels instead, which leaves a spike on the chart.

**Funds.** Every ~60 s, and soon after an `insufficient-*` rejection, each bot reads `/me/wallet` and
`/me/inventory`. If anything is low, it asks for one generous grant that covers everything:

| | credits below → grant | items below → topped up to |
|---|---|---|
| maker | 2 000 000 → +3 000 000 | 300 → 900 (50 → 150 for items of 1 000+ credits) |
| taker | 300 000 → +700 000 | 48 → 144 (24 → 72) |

**Startup:**

1. Wait for `/actuator/health/readiness`.
2. Read the market list. It is read again every 3 minutes, so new markets are picked up.
3. Sign in every bot.
4. Top up balances.
5. Cancel the bots' leftover active orders.
6. Start trading.

**Shutdown** on SIGTERM/SIGINT:

1. Stop the loops.
2. Give requests already in flight a moment to finish.
3. Cancel every open order, the ones the bots know about plus whatever `/me/orders` lists, within about 5 s.
4. Exit with code 0.

A second signal exits at once.

### Robustness

- 429, 5xx and network errors are retried with exponential backoff and jitter. Each retry sends the same body,
  so an order keeps its `clientOrderId` (a fresh UUID per order intent).
- Other 4xx responses are logged with their Problem Details `type`, and the bot moves on. The expected ones
  are not logged: `insufficient-*`, `order-closed`, and 401, which makes the bot sign in again with
  `POST /internal/v1/bots`.
- A loop that keeps failing backs off up to a minute. Nothing an API returns stops the process.
- Order and cancel requests of all bots share one token bucket of `BOT_ORDERS_PER_SECOND`, and every retry
  takes a token too. The cleanup at shutdown is the one exception: it bypasses the bucket so that it fits into
  the 5 s budget. Reads are not limited.
- Local state is bounded: per maker and market at most ~10 tracked orders plus a capped list of pending cancels.
  The rest is counters.
- HTTP goes through `node:http` with a keep-alive agent rather than `fetch`. undici and its WebAssembly parser
  cost about 10–40 MB more resident memory in measurements here.

### Logs

Each line starts with the time and the bot name, for example
`2026-10-10T15:04:05.123Z INFO  [maker-1] message`. At `info` level the bots log:

- startup steps;
- grants, sweeps and new sign-ins;
- failed requests;
- the shutdown;
- a summary every minute:

```
INFO  [bots] last 60 s: placed 79, canceled 24, fills 51, errors 0 | resting 57, waiting for rate limit 0 | fair: iron_ore 301, coal 122, crystal 2484 | rss 64 MB
```

At `debug` level, every order, cancel, fill and retry gets a line too.

## Configuration

| Variable | Default | |
|---|---|---|
| `CORE_URL` | `http://localhost:8080` | Core itself, not the gateway: the gateway does not forward `/internal`. In the cluster this is `http://core-api`. |
| `INTERNAL_TOKEN` | required | Sent as `X-Internal-Token`; must match the secret core is configured with. |
| `BOT_MAKERS` | `2` | 0–20 |
| `BOT_TAKERS` | `3` | 0–50 |
| `BOT_ORDERS_PER_SECOND` | `2` | Cap on order and cancel requests of all bots together, fractions allowed. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

An invalid value stops the process at startup with exit code 1 and a message.

## Running

Node 22 or newer.

```sh
npm ci
npm run build
CORE_URL=http://localhost:8080 INTERNAL_TOKEN=... npm start
```

Core needs:

- the internal API enabled, with the same secret;
- the readiness probe exposed. Spring Boot does this by itself only on Kubernetes; locally, set
  `management.endpoint.health.probes.enabled=true`.

With Docker:

```sh
docker build -t game-item-exchange/bots:dev clients/bots
docker run -e CORE_URL=http://host.docker.internal:8080 -e INTERNAL_TOKEN=... game-item-exchange/bots:dev
```

The image contains only `dist/` and `package.json`, runs as the `node` user and caps the heap at 48 MB.

## Tests

```sh
npm test
```

This compiles `src/` and `test/` into `dist-test/` and runs `node --test`. About 20 s.

Unit tests:

- the price walk stays within its bounds over a simulated week, reverts to the anchor, and moves the 1-minute
  chart by a few tenths of a percent;
- maker ladders never self-cross, keep prices ≥ 1 and respect the order limit (a property test over thousands
  of random states);
- the token bucket limits the rate;
- the backoff grows and is capped;
- grants and configuration.

Integration tests use `test/fake-core.ts`. It is an in-memory core on `node:http` with a matcher that, like
the real one, processes orders a few milliseconds after `202 PENDING`, in arrival order. One test runs
2 makers and 3 takers for 10 s and injects 3% faults (503, 429, and 500 after the work was done), a market
that appears midway, revocation of all tokens, and leftover orders. It then checks that:

- there are orders on both sides of every market and trades in every market;
- no maker traded with itself or had crossing orders;
- no request was malformed and no `clientOrderId` was reused;
- leftovers were canceled and nothing was left open after the shutdown.

Two more tests check that all bots together respect `BOT_ORDERS_PER_SECOND`, and that `main.js` started
from the environment cancels everything on SIGTERM and exits with 0.

## Source layout

| File | |
|---|---|
| `src/main.ts` | Entry point: configuration, signals |
| `src/app.ts` | Startup sequence, loops, shutdown |
| `src/maker.ts`, `src/taker.ts`, `src/bot.ts` | The bots; funds loop and cleanup in `bot.ts` |
| `src/ladder.ts` | Ladder prices, the requote plan, the self-cross check (pure functions) |
| `src/price.ts`, `src/markets.ts` | Fair-price walk; markets, anchors, quantities |
| `src/funds.ts` | Top-up thresholds |
| `src/api.ts`, `src/http.ts` | API client: retries, Problem Details, sign-in on 401 |
| `src/rate-limiter.ts`, `src/backoff.ts`, `src/sleep.ts`, `src/random.ts` | Small building blocks |
| `src/tuning.ts` | Timings; tests pass faster ones |
