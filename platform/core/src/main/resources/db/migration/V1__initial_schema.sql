-- Core database, initial schema.
-- Enum-like columns are text with check constraints; their values are exactly the names
-- of the corresponding Kotlin enums, so they map directly without conversion.

-- ============================================================
-- Users
-- ============================================================

create table users (
    user_id     bigint generated always as identity primary key,
    created_at  timestamptz not null default now()
);

-- How a user signs in. One user may have several identities (password now, Telegram later).
create table user_identities (
    provider     text        not null check (provider in ('PASSWORD')),
    subject      text        not null,  -- login for PASSWORD, external user id for other providers
    user_id      bigint      not null references users,
    secret_hash  text,                  -- password hash; null for providers without a secret
    created_at   timestamptz not null default now(),
    primary key (provider, subject)
);
create index on user_identities (user_id);

-- ============================================================
-- Games, item definitions, markets
-- ============================================================

create table games (
    game_id       text        primary key check (game_id ~ '^[a-z0-9_-]+$'),
    name          text        not null,
    api_key_hash  text        not null unique,
    status        text        not null default 'ACTIVE' check (status in ('ACTIVE', 'FROZEN')),
    created_at    timestamptz not null default now()
);

create table item_definitions (
    game_id     text        not null references games,
    def_id      text        not null check (def_id ~ '^[a-z0-9_-]+$'),
    kind        text        not null check (kind in ('UNIQUE', 'FUNGIBLE')),
    name        text        not null,
    tradable    boolean     not null default true,
    schema      jsonb       not null default '{}',  -- attribute declarations and display templates
    created_at  timestamptz not null default now(),
    primary key (game_id, def_id)
);

create table markets (
    market_key      text        primary key,
    market_id       bigint      generated always as identity unique,
    game_id         text        not null,
    def_id          text        not null,
    key_attributes  jsonb       not null default '{}',
    event_sequence  bigint      not null default 0,  -- last sequence number used in market-events
    created_at      timestamptz not null default now(),
    foreign key (game_id, def_id) references item_definitions
);
create index on markets (game_id, def_id);

-- ============================================================
-- Items
-- ============================================================

-- Unique items: one row per item.
create table assets (
    asset_id    bigint      generated always as identity primary key,
    market_key  text        not null references markets,
    owner_id    bigint      not null references users,
    state       text        not null default 'AVAILABLE' check (state in ('AVAILABLE', 'LISTED', 'BURNED')),
    attributes  jsonb       not null default '{}',
    version     int         not null default 1,
    created_at  timestamptz not null default now()
);
create index on assets (owner_id) where state <> 'BURNED';
create index on assets (market_key);
create index on assets using gin (attributes jsonb_path_ops);

-- Fungible items: how many of each an owner has.
create table balances (
    owner_id    bigint not null references users,
    market_key  text   not null references markets,
    available   bigint not null default 0 check (available >= 0),
    reserved    bigint not null default 0 check (reserved >= 0),  -- locked by open sell orders
    primary key (owner_id, market_key)
);

-- Every mint and burn performed by a game: the audit trail of third-party games.
create table item_events (
    item_event_id  bigint      generated always as identity primary key,
    kind           text        not null check (kind in ('MINT', 'BURN')),
    game_id        text        not null references games,
    owner_id       bigint      not null references users,
    market_key     text        not null references markets,
    asset_id       bigint      references assets,  -- set for unique items
    quantity       bigint      not null check (quantity > 0),
    created_at     timestamptz not null default now(),
    check (asset_id is null or quantity = 1)
);
create index on item_events (game_id, created_at);

-- ============================================================
-- Ledger (credits)
-- ============================================================

create table accounts (
    account_id  bigint generated always as identity primary key,
    owner_id    bigint references users,  -- null for platform accounts
    kind        text   not null check (kind in ('AVAILABLE', 'RESERVED', 'FEES', 'GRANTS')),
    balance     bigint not null default 0,  -- cache of sum(postings.amount), updated in the same transaction
    unique nulls not distinct (owner_id, kind),
    -- Platform accounts have no owner, user accounts always have one.
    check ((owner_id is null) = (kind in ('FEES', 'GRANTS'))),
    -- Source accounts go negative by design: their balance is the amount of credits they issued.
    check (kind = 'GRANTS' or balance >= 0)
);

create table ledger_transactions (
    ledger_tx_id  bigint      generated always as identity primary key,
    kind          text        not null check (kind in ('GRANT', 'RESERVE', 'RELEASE', 'TRADE')),
    reference     text,  -- what caused it: order id, trade id
    created_at    timestamptz not null default now()
);

-- Postings of one transaction always sum to zero; enforced by the code that writes them
-- and checked by reconciliation.
create table postings (
    posting_id    bigint generated always as identity primary key,
    ledger_tx_id  bigint not null references ledger_transactions,
    account_id    bigint not null references accounts,
    amount        bigint not null check (amount <> 0)
);
create index on postings (ledger_tx_id);
create index on postings (account_id);

insert into accounts (owner_id, kind) values (null, 'FEES'), (null, 'GRANTS');

-- ============================================================
-- Orders and trades
-- ============================================================

-- Ids of commands sent to the matcher (OrderCommand.commandId).
create sequence command_id_seq;

create table orders (
    order_id         bigint      generated always as identity primary key,
    client_order_id  text        not null check (length(client_order_id) between 1 and 64),
    market_key       text        not null references markets,
    owner_id         bigint      not null references users,
    side             text        not null check (side in ('BUY', 'SELL')),
    price            bigint      not null check (price > 0),
    quantity         bigint      not null check (quantity > 0),
    filled           bigint      not null default 0,
    time_in_force    text        not null default 'GTC' check (time_in_force in ('GTC', 'IOC', 'FOK')),
    asset_id         bigint      references assets,  -- sell order of a unique item
    target_order_id  bigint      references orders,  -- take: the listing being bought
    status           text        not null default 'PENDING' check (status in ('PENDING', 'OPEN', 'CLOSED')),
    close_reason     text        check (close_reason in ('FILLED', 'CANCELED', 'IOC_UNFILLED', 'FOK_UNFILLED',
                                                         'TARGET_UNAVAILABLE', 'TARGET_PRICE_MISMATCH')),
    created_at       timestamptz not null default now(),
    closed_at        timestamptz,
    unique (owner_id, client_order_id),
    check (filled between 0 and quantity),
    check (asset_id is null or (side = 'SELL' and quantity = 1)),
    check (target_order_id is null or (side = 'BUY' and quantity = 1)),
    check ((status = 'CLOSED') = (close_reason is not null))
);
-- An item can be in at most one active sell order, whatever the code does.
create unique index on orders (asset_id) where asset_id is not null and status <> 'CLOSED';
create index on orders (market_key, side, price) where status = 'OPEN';
create index on orders (owner_id, created_at desc);

create table trades (
    trade_id       text        primary key,  -- MatchResultId of the TradeExecuted result
    market_key     text        not null references markets,
    buy_order_id   bigint      not null references orders,
    sell_order_id  bigint      not null references orders,
    taker_side     text        not null check (taker_side in ('BUY', 'SELL')),
    price          bigint      not null check (price > 0),
    quantity       bigint      not null check (quantity > 0),
    fee            bigint      not null check (fee >= 0),
    asset_id       bigint      references assets,
    occurred_at    timestamptz not null,  -- logical time from the matcher
    settled_at     timestamptz not null default now()
);
create index on trades (market_key, occurred_at);

-- Every match result applied by settlement. Protects against duplicates after a matcher replay.
create table processed_match_results (
    result_id     text        primary key,
    processed_at  timestamptz not null default now()
);

-- ============================================================
-- Outbox and notifications
-- ============================================================

create table outbox (
    outbox_id    bigint      generated always as identity primary key,
    topic        text        not null,
    message_key  text        not null,
    payload      text        not null,  -- exactly the bytes to send, as produced by ContractsJson
    created_at   timestamptz not null default now(),
    sent_at      timestamptz
);
create index on outbox (outbox_id) where sent_at is null;

-- Stored as kind and parameters, not as text: the UI builds the text and can localize it.
create table notifications (
    notification_id  bigint      generated always as identity primary key,
    user_id          bigint      not null references users,
    kind             text        not null,  -- ITEM_SOLD, ITEM_BOUGHT, ...
    params           jsonb       not null default '{}',
    created_at       timestamptz not null default now(),
    read_at          timestamptz
);
create index on notifications (user_id, created_at desc) where read_at is null;
