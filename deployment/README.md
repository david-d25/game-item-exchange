# Production deployment

The exchange runs on a VDS next to other projects, as five containers in Docker Compose
([compose.yaml](compose.yaml)): the gateway (the web image), core, the matcher, the bots and a single Kafka
broker. The host's own nginx terminates TLS and forwards `/exchange/` to the gateway, which listens on
`127.0.0.1` only. PostgreSQL is the host's own, outside of this project; core reaches it through
`host.docker.internal`.

Kubernetes ([deploy/k8s](../deploy/k8s)) remains the local environment: two core replicas, a separate relay,
two matchers, Strimzi, Prometheus and Grafana. On a server with a few gigabytes of memory shared with other
projects, that costs more than it shows, so production runs the same images in the smallest working shape:

| | Kubernetes | Here |
|---|---|---|
| core | 2 × API with settlement, 1 × relay | 1 process doing all three |
| matcher | 2 instances, partitions split between them | 1 instance with all 12 partitions |
| Kafka | Strimzi, topics from `KafkaTopic` resources | `apache/kafka-native`, topics created by core at startup |
| Monitoring | Prometheus, Grafana | `docker stats` and logs |

Expected memory: about 700 MB in total, with limits that add up to about 1.3 GB.

Nothing is built on the server: CI builds the images, tags them with the commit and pushes them to GHCR,
and the server only pulls. The workflows are in [.github/workflows](../.github/workflows):

- **Deploy**: every push to `main`, or by hand. Builds, tests, publishes and restarts.
- **CI**: the same checks on pull requests, without publishing.

## One-time setup on the server

The `deploy` user from the other projects can be reused:

```sh
sudo install -d -o deploy -g deploy /srv/game-item-exchange
```

### PostgreSQL

Version 15 or newer (the schema uses `unique nulls not distinct`). A database and a role of its own:

```sh
sudo -u postgres psql <<'SQL'
create role exchange login password '<password>';
create database exchange owner exchange;
SQL
```

PostgreSQL has to accept connections from the Docker networks, not only from `localhost`: check
`listen_addresses` and add a line to `pg_hba.conf` if the existing ones name their databases, for example

```
host  exchange  exchange  172.16.0.0/12  scram-sha-256
```

followed by `sudo systemctl reload postgresql`. Flyway creates the schema on the first start.

### `.env`

In `/srv/game-item-exchange`, copy [.env.example](.env.example) to `.env` and fill it in:
the database password, two fresh secrets, a free port and the uid of `deploy`. Then
`chmod 600 .env`. Neither `.env` nor `kafka-data/` is in the archive CI ships, so both survive every deploy.
On the first deploy the example is shipped along with the rest; until then, take it from the repository.

### The host's nginx

One rule. The prefix is *not* stripped: the gateway serves the site under `/exchange/` and the API under
`/exchange/api/`.

```nginx
location /exchange/ {
    proxy_pass         http://127.0.0.1:8090;   # APP_PORT
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
}

location = /exchange {
    return 301 /exchange/;
}
```

The gateway limits requests per client address and takes that address from `X-Real-IP`, so the header
is required: without it every visitor would share one limit.

## GitHub

Repository **variables** (Settings → Secrets and variables → Actions), the same as for the other projects
except the path:

| | |
|---|---|
| `DEPLOY_HOST` | the VDS |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_PATH` | `/srv/game-item-exchange` |
| `DEPLOY_HOST_KEY` | optional: the host's line from `ssh-keyscan -t ed25519 <host>`, to pin it |

Repository **secret**: `DEPLOY_KEY`, the private half of the deploy key.

Until `DEPLOY_HOST` is set the deploy job is skipped, so building and publishing work from the first commit.

The first push **creates the four packages as private** (`game-item-exchange/core`, `matcher`, `web` and
`bots`), and the server has to be allowed to pull them. Either make them public (Package settings → Change
visibility; none contains secrets, they come from `.env` at run time), or sign in once on the server with a
token that has `read:packages`:

```sh
echo <token> | docker login ghcr.io -u <user> --password-stdin
```

This is the usual reason a first deploy fails with `denied` or `manifest unknown`.

## By hand, on the server

```sh
cd /srv/game-item-exchange
docker compose pull && docker compose up -d     # deploy whatever TAG says
docker compose ps                               # core and kafka should be "healthy"
docker compose logs -f core
docker stats --no-stream
```

Rolling back is the same with an older commit:

```sh
sed -i 's/^TAG=.*/TAG=<sha>/' .env && docker compose up -d
```

Flyway migrations run on startup and are not undone by a rollback: going back past a migration means
the old code runs against the new schema.

## Data

Everything that matters is in two places, and they belong together:

- the `exchange` database: users, balances, orders, trades, the ledger;
- `kafka-data/`: the `orders` topic, from which the matcher rebuilds its order books at every start.

Losing only one of them leaves the other inconsistent: orders that core considers open but the matcher has
never seen, or the reverse. To start from scratch, drop both: stop the project, recreate the database,
delete `kafka-data/`, start again. Old tokens stop working, even when their user id is taken again by
someone new (core rejects a token issued before its user was created): visitors find themselves signed out,
and the bots sign in again by themselves.

Kafka keeps `orders` forever, so `kafka-data/` grows with the bots' activity (on the order of tens of
megabytes a day at one order per second) and the matcher's replay at startup grows with it. Snapshots of the
order books would bound both; until they exist, starting from scratch now and then is the way to reset.
