-- The demo catalog: one game with three fungible markets. Part of the schema history rather than
-- the dev seed, because production needs it too. "on conflict do nothing" keeps databases where
-- the dev seed created some of these rows earlier.
--
-- The game has no API key yet: the placeholder below cannot match any key's hash.

insert into games (game_id, name, api_key_hash)
values ('idle-mine', 'Idle Mine', 'not-issued:idle-mine')
on conflict (game_id) do nothing;

insert into item_definitions (game_id, def_id, kind, name)
values ('idle-mine', 'iron_ore', 'FUNGIBLE', 'Iron ore'),
       ('idle-mine', 'coal', 'FUNGIBLE', 'Coal'),
       ('idle-mine', 'crystal', 'FUNGIBLE', 'Crystal')
on conflict (game_id, def_id) do nothing;

insert into markets (market_key, game_id, def_id)
values ('idle-mine/iron_ore', 'idle-mine', 'iron_ore'),
       ('idle-mine/coal', 'idle-mine', 'coal'),
       ('idle-mine/crystal', 'idle-mine', 'crystal')
on conflict (market_key) do nothing;
