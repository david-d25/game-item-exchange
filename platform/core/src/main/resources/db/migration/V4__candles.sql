-- One-minute candles, updated by settlement in the same transaction as the trade.
-- Charts and 24-hour statistics read these instead of scanning every trade: a week of
-- one-minute candles is about ten thousand rows, while bots alone make tens of thousands
-- of trades a day. Longer intervals are aggregated from these on the fly.

create table candles_1m (
    market_key  text        not null references markets,
    bucket      timestamptz not null,  -- start of the minute
    open        bigint      not null,
    high        bigint      not null,
    low         bigint      not null,
    close       bigint      not null,
    volume      bigint      not null,
    pv          numeric     not null,  -- sum of price × quantity, for the volume-weighted average price
    trades      int         not null,
    primary key (market_key, bucket)
);

-- Trades settled before this migration
insert into candles_1m (market_key, bucket, open, high, low, close, volume, pv, trades)
select market_key,
       date_bin('1 minute', occurred_at, timestamptz '2000-01-01 00:00:00+00') as bucket,
       (array_agg(price order by occurred_at, settled_at))[1],
       max(price),
       min(price),
       (array_agg(price order by occurred_at desc, settled_at desc))[1],
       sum(quantity),
       sum(price::numeric * quantity),
       count(*)
from trades
group by market_key, bucket;
