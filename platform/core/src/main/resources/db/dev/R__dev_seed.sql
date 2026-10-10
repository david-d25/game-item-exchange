-- Development data: two users with credits, Bob owns iron ore. The game and its markets come from
-- the V3 migration. Applied only in the dev profile. Runs after all versioned migrations and does nothing
-- if users already exist: to apply a changed seed, reset the local database.
do $$
    declare
        alice          bigint;
        bob            bigint;
        grants_account bigint;
        tx             bigint;
    begin
        if exists (select 1 from users) then
            return;
        end if;

        insert into users (display_name) values ('Alice') returning user_id into alice;
        insert into users (display_name) values ('Bob') returning user_id into bob;

        insert into user_identities (provider, subject, user_id)
        values ('PASSWORD', 'alice', alice),
               ('PASSWORD', 'bob', bob);

        insert into accounts (owner_id, kind)
        values (alice, 'AVAILABLE'), (alice, 'RESERVED'),
               (bob, 'AVAILABLE'), (bob, 'RESERVED');

        select account_id into grants_account from accounts where kind = 'GRANTS';

        -- 100 000 starting credits for each user, as a proper ledger transaction that sums to zero
        insert into ledger_transactions (kind, reference)
        values ('GRANT', 'dev-seed')
        returning ledger_tx_id into tx;

        insert into postings (ledger_tx_id, account_id, amount)
        select tx, account_id, 100000 from accounts where owner_id in (alice, bob) and kind = 'AVAILABLE'
        union all
        select tx, grants_account, -200000;

        update accounts set balance = balance + 100000 where owner_id in (alice, bob) and kind = 'AVAILABLE';
        update accounts set balance = balance - 200000 where account_id = grants_account;

        -- Bob owns 50 iron ore minted by the game
        insert into balances (owner_id, market_key, available)
        values (bob, 'idle-mine/iron_ore', 50);

        insert into item_events (kind, game_id, owner_id, market_key, quantity)
        values ('MINT', 'idle-mine', bob, 'idle-mine/iron_ore', 50);
    end $$;
