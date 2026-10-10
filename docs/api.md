# Platform HTTP API, v1

The contract between core and its clients: the web app, the bots and, later, games.
Kafka message formats are a separate contract and live in `platform/contracts`.

## Conventions

- JSON with camelCase field names.
- Credits and quantities are integers. There are no fractions anywhere.
- Timestamps are ISO-8601 strings in UTC, for example `2026-10-10T15:04:05.123Z`.
- Ids are positive integers, except `tradeId`, which is a string like `"1042-0"`.
- Errors use Problem Details (RFC 9457). Clients branch on `type`, `detail` is for humans:

  ```json
  { "type": "/problems/insufficient-funds", "title": "Insufficient funds", "status": 422,
    "detail": "The order requires 18600 credits, 12000 available" }
  ```

- Authentication: `Authorization: Bearer <token>`. A missing or invalid token on an endpoint that needs
  a user gives `401` with type `/problems/unauthorized`.
- Core serves the public API under `/api/v1`. Browsers reach it through the gateway, which serves the site
  under `/exchange/` and forwards `/exchange/api/...` to core's `/api/...`. Internal endpoints under
  `/internal/v1` are never reachable through the gateway.
- The gateway answers some requests itself, with Problem Details too: `429` with type
  `/problems/too-many-requests` (about 20 requests per second per address) or `/problems/too-many-guests`,
  and `503` with type `/problems/unavailable` while core is not answering, for example during a deploy.
  Both carry `Retry-After` in seconds.

## Auth

### `POST /api/v1/auth/guest`

Creates a guest user with a starter pack and returns a token for it. No request body.

`201 Created`:

```json
{ "token": "eyJhbGciOiJIUzI1NiJ9...", "userId": 42, "displayName": "Guest 42",
  "expiresAt": "2026-11-09T15:04:05Z" }
```

The starter pack is 50 000 credits and some items of every market (iron ore, coal, crystals).
`429` with type `/problems/too-many-guests` when too many guests were created recently.

## Me

All of these need a token.

| Method and path | Response |
|---|---|
| `GET /api/v1/me` | `{ "userId": 42, "displayName": "Guest 42" }` |
| `GET /api/v1/me/wallet` | `{ "available": 81900, "reserved": 3100 }` |
| `GET /api/v1/me/inventory` | see below |
| `GET /api/v1/me/orders` | list of `Order`, newest first |
| `GET /api/v1/me/notifications` | see below |
| `POST /api/v1/me/notifications/read` | `204`, marks all notifications as read |

`GET /api/v1/me/inventory`:

```json
{
  "fungible": [
    { "marketId": 1, "gameId": "idle-mine", "defId": "iron_ore", "name": "Iron ore",
      "available": 50, "reserved": 10 }
  ],
  "unique": []
}
```

`reserved` items are locked by the user's open sell orders.

`GET /api/v1/me/orders?status=ACTIVE&marketId=1&limit=50`:

- `status`: `ACTIVE` (PENDING and OPEN, the default), `CLOSED` or `ALL`;
- `marketId`: optional filter;
- `limit`: 1 to 200, default 50.

`GET /api/v1/me/notifications?limit=20`:

```json
{
  "unread": 1,
  "items": [
    { "notificationId": 7, "kind": "ITEM_SOLD", "read": false, "createdAt": "2026-10-10T15:04:05Z",
      "params": { "marketKey": "idle-mine/iron_ore", "quantity": 50, "price": 300, "proceeds": 14250 } },
    { "notificationId": 6, "kind": "ITEM_BOUGHT", "read": true, "createdAt": "2026-10-10T15:03:00Z",
      "params": { "marketKey": "idle-mine/coal", "quantity": 5, "price": 120 } }
  ]
}
```

Newest first. `proceeds` is what the seller received after the fee.

## Orders

### `POST /api/v1/orders`

```json
{ "clientOrderId": "3f1c2a9e-6b0d-4d1e-9a52-1f7f0c8e4b21", "marketId": 1, "side": "BUY",
  "price": 310, "quantity": 60, "timeInForce": "GTC" }
```

- `clientOrderId`: 1 to 64 characters, chosen by the client once per user intent (a UUID) and reused
  when retrying the same request. The same id with different parameters is an error.
- `side`: `BUY` or `SELL`.
- `price`: limit price per item: a buy pays at most this, a sell receives at least this. 1 to 10⁹.
- `quantity`: 1 to 10⁹.
- `timeInForce`: `GTC` (default): the unfilled rest waits in the book until filled or canceled;
  `IOC`: fill what is possible right now, cancel the rest; `FOK`: fill everything right now or nothing.

Responses:

| Status | Meaning |
|---|---|
| `202` `{ "orderId": 9001, "status": "PENDING" }` | accepted, the matcher will process it in well under a second |
| `200` same body | a retry of an earlier request with the same `clientOrderId` |
| `400` `/problems/invalid-request` | malformed values |
| `404` `/problems/not-found` | no such market |
| `409` `/problems/client-order-id-reused` | the same `clientOrderId` with different parameters |
| `422` `/problems/insufficient-funds` | a buy needs `price × quantity` available credits |
| `422` `/problems/insufficient-items` | a sell needs `quantity` available items |
| `422` `/problems/market-closed` | the market is not open for trading |

A buy reserves `price × quantity` credits. When it trades at a lower price, the difference comes back
immediately; when it closes unfilled, the reservation of the rest comes back. A sell reserves the items.
The fee is 5% of the trade value and is paid by the seller.

### `GET /api/v1/orders/{orderId}`

Returns one `Order` of the current user:

```json
{ "orderId": 9001, "clientOrderId": "3f1c...", "marketId": 1, "side": "BUY", "price": 310,
  "quantity": 60, "filled": 50, "timeInForce": "GTC", "assetId": null, "targetOrderId": null,
  "status": "OPEN", "closeReason": null, "createdAt": "2026-10-10T15:04:05Z" }
```

- `status`: `PENDING` (accepted, not processed by the matcher yet), `OPEN` (waiting in the book),
  `CLOSED` (finished for good).
- `closeReason` is set exactly when the order is `CLOSED`: `FILLED`, `CANCELED`, `IOC_UNFILLED`,
  `FOK_UNFILLED`, `TARGET_UNAVAILABLE`, `TARGET_PRICE_MISMATCH`.

### `POST /api/v1/orders/{orderId}/cancel`

`202` with an empty body: the cancel request is on its way to the matcher, and the order becomes `CLOSED`
with `CANCELED` shortly after. If it was filled in the meantime, it closes as `FILLED` instead.
`409` `/problems/order-closed` when the order is already closed.

## Markets

Public, no token needed.

### `GET /api/v1/markets` and `GET /api/v1/markets/{marketId}`

A list of `MarketSummary` ordered by `marketId`, or one of them:

```json
{ "marketId": 1, "marketKey": "idle-mine/iron_ore", "gameId": "idle-mine", "gameName": "Idle Mine",
  "defId": "iron_ore", "name": "Iron ore", "kind": "FUNGIBLE",
  "lastPrice": 312, "open24h": 298, "volume24h": 1840, "trades24h": 411,
  "bestBid": 310, "bestAsk": 314 }
```

- `lastPrice`: price of the latest trade, `null` if there were none.
- `open24h`: price of the first trade within the last 24 hours, `null` if there were none.
- `volume24h`: items traded within the last 24 hours; `trades24h`: number of trades.
- `bestBid` / `bestAsk`: the highest open buy and the lowest open sell price, `null` if that side is empty.

### `GET /api/v1/markets/{marketId}/book?depth=50`

```json
{ "marketId": 1, "marketKey": "idle-mine/iron_ore", "sequence": 41,
  "asks": [ { "price": 314, "quantity": 25, "orders": 2 } ],
  "bids": [ { "price": 310, "quantity": 100, "orders": 1 } ] }
```

Price levels: `asks` cheapest first, `bids` most expensive first. `depth` is 1 to 500.

### `GET /api/v1/markets/{marketId}/trades?limit=50`

Latest trades, newest first. `limit` is 1 to 200.

```json
[ { "tradeId": "1042-0", "price": 312, "quantity": 5, "takerSide": "BUY",
    "occurredAt": "2026-10-10T15:04:05.123Z" } ]
```

`takerSide` is the side of the order that arrived and took liquidity: `BUY` means someone bought at
the sellers' price (usually shown green), `SELL` means someone sold at the buyers' price (red).

### `GET /api/v1/markets/{marketId}/candles?interval=1m&limit=120`

Trades aggregated into time buckets, oldest first. `interval` is `1m`, `5m` or `1h`; `limit` is 1 to 500
and counts buckets back from now. Only buckets with at least one trade are returned, so gaps are possible.

```json
[ { "time": "2026-10-10T15:04:00Z", "open": 310, "high": 315, "low": 309, "close": 312,
    "volume": 40, "vwap": 311.6 } ]
```

`time` is the start of the bucket; `vwap` is the volume-weighted average price, a number with a fraction.

## Internal API

For the bots, which run next to core. Reached on core directly (for example `http://core:8080`), never
through the gateway. Every request needs the header `X-Internal-Token` with the shared secret core is
configured with: without it the response is `403`; when core has no secret configured, these endpoints
answer `404`.

### `POST /internal/v1/bots`

```json
{ "name": "maker-1" }
```

Gets or creates the bot user with this name (`[a-z0-9-]`, 1 to 32 characters) and returns a fresh token,
valid for 30 days:

```json
{ "userId": 3, "displayName": "maker-1", "token": "eyJ..." }
```

### `POST /internal/v1/users/{userId}/grants`

```json
{ "credits": 1000000, "items": [ { "marketId": 1, "quantity": 2000 } ] }
```

Gives the user credits (a ledger grant) and mints fungible items into their inventory. `credits` is
0 or more, `items` may be empty. `204` on success.

### `GET /actuator/health/readiness`

`200` with `{ "status": "UP" }` once core is ready. Also internal only.

## Demo catalog

One game, `idle-mine` ("Idle Mine"), with three fungible markets:

| Item | `defId` | Typical price |
|---|---|---|
| Iron ore | `iron_ore` | about 300 |
| Coal | `coal` | about 120 |
| Crystal | `crystal` | about 2 500 |

Clients must not hardcode `marketId`s: they come from `GET /api/v1/markets`.
