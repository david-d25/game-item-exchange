-- Guests sign in with a token only; bots get their token from the internal API.
-- Both are ordinary users with ordinary accounts, they differ only in how they sign in.

alter table users add column display_name text;

alter table user_identities drop constraint user_identities_provider_check;
alter table user_identities add constraint user_identities_provider_check
    check (provider in ('PASSWORD', 'GUEST', 'BOT'));

-- Counting recent guests, to cap how many can be created per hour
create index on user_identities (provider, created_at);

-- Bots ask for their active orders all the time while accumulating closed ones by the hundred
-- thousand; without this index every such query would walk all of them.
create index on orders (owner_id, created_at desc) where status <> 'CLOSED';

-- The notification list, read and unread
create index on notifications (user_id, created_at desc);
