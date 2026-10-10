# Web app and gateway

The public site of Game Item Exchange: markets, a trading page with the order book, chart, tape and order form,
a portfolio and an About page. React, TypeScript and Vite; charts by
[TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/). It talks to core only through
the HTTP API in [`docs/api.md`](../../docs/api.md) and polls it: book and trades every 2 s, candles every 10 s,
the viewer's orders and wallet every 3 s, nothing while the tab is hidden.

The same image is the gateway in front of core: nginx serves the site under `/exchange/` and forwards
`/exchange/api/...` to core's `/api/...`. Nothing else reaches core.

## Run locally

Node 22.12 or newer.

```sh
npm ci
npm run fake    # fake core on :8080: three demo markets, bots, guests, orders, in memory
npm run dev     # http://localhost:5173/exchange/
```

`dev/fake-core.mjs` implements the endpoints of `docs/api.md` that the site uses, with a small price-time matcher
and bots that quote and trade, so pages look alive without Postgres, Kafka or the JVM. Against a real core, skip
`npm run fake` and point the dev proxy at it:

```sh
VITE_CORE_URL=http://localhost:8080 npm run dev
```

The dev server (and `npm run preview`) proxies `/exchange/api` to `VITE_CORE_URL` (default `http://localhost:8080`),
rewriting it to `/api`, the same way the gateway does.

| Script | |
|---|---|
| `npm run dev` | Vite dev server with the API proxy |
| `npm run build` | type check (strict) and production build into `dist/` |
| `npm run preview` | serves `dist/` with the same proxy |
| `npm run fake` | the fake core |

## Deploy

```sh
docker build -t game-item-exchange/web:dev platform/web
docker run -p 8081:80 -e CORE_URL=http://core:8080 game-item-exchange/web:dev
# http://localhost:8081/exchange/
```

- The build stage runs `npm ci && npm run build`; the final stage is `nginx:1.27-alpine` with the site in
  `/usr/share/nginx/html/exchange/` and [`nginx/default.conf.template`](nginx/default.conf.template).
- `CORE_URL`: core's base URL, no trailing slash. Defaults to `http://core-api.gie.svc.cluster.local`, the
  Service in `deploy/k8s`. It is substituted into the template when the container starts. nginx looks the name
  up again every 10 s through the nameservers of the container (so a restarted core with a new IP address is
  found), and its resolver ignores search domains: in Kubernetes the name must be fully qualified.
- Base path: the site is built for `/exchange/` (Vite `base`, router `basename`), and the API is called at
  `/exchange/api/v1`. `/` redirects to `/exchange/`.
- The gateway trusts `X-Real-IP` from private networks (the host nginx or Traefik in front), limits the API to
  about 20 requests per second per client (burst 40) and guest creation to 6 per minute (burst 3), answering
  `429` with Problem Details. Hashed assets are cached for a year, `index.html` is revalidated on every load.
- `GET /healthz` answers `200 ok` for probes.
