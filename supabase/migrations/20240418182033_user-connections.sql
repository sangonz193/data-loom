-- Tables
create table web_rtc_signals (
  id uuid primary key default uuid_generate_v4(),
  from_user_id uuid references users(id) on delete cascade not null,
  to_user_id uuid references users(id) on delete cascade not null,
  payload jsonb not null,
  created_at timestamp with time zone default now() not null
);

create table pairing_codes (
  code text primary key,
  user_id uuid references users(id) on delete cascade not null,
  created_at timestamp with time zone default now() not null
);

create table pairing_code_redemptions (
  pairing_code text references pairing_codes(code) on delete cascade primary key,
  user_id uuid references users(id) on delete cascade not null,
  created_at timestamp with time zone default now() not null
);

create table user_connections (
  user_1_id uuid references users(id) on delete cascade not null,
  user_2_id uuid references users(id) on delete cascade not null,
  created_at timestamp with time zone default now() not null,
  primary key (user_1_id, user_2_id)
);

-- Enable realtime
alter
  publication supabase_realtime add table web_rtc_signals;
alter
  publication supabase_realtime add table pairing_code_redemptions;
alter
  publication supabase_realtime add table user_connections;

-- RLS for web_rtc_signals
alter table web_rtc_signals enable row level security;

create policy select_if_from_or_to_user
on web_rtc_signals
for select
using (auth.uid() = from_user_id or auth.uid() = to_user_id);

create function insert_if_code_redemption_exists(p_to_user_id uuid) returns boolean as $$
  select exists (
    select 1
    from pairing_code_redemptions
    join pairing_codes on pairing_code_redemptions.pairing_code = pairing_codes.code
    where (
      (
        pairing_codes.user_id = auth.uid()
        and pairing_code_redemptions.user_id = p_to_user_id
      )
      or (
        pairing_codes.user_id = p_to_user_id
        and pairing_code_redemptions.user_id = auth.uid()
      )
    )
  )
$$ language sql security definer;

create policy insert_if_code_redemption_exists
on web_rtc_signals
for insert
with check (
  auth.uid() = from_user_id
  and insert_if_code_redemption_exists(to_user_id)
);

create policy insert_if_user_connection_exists
on web_rtc_signals
for insert
with check (
  auth.uid() = from_user_id
  and (
    exists (
      select 1
      from user_connections
      where (
        (
          user_1_id = from_user_id
          and user_2_id = to_user_id
        )
        or (
          user_1_id = to_user_id
          and user_2_id = from_user_id
        )
      )
    )
  )
);

create policy delete_if_from_user
on web_rtc_signals
for delete
using (auth.uid() = from_user_id);

-- RLS for pairing_codes
alter table pairing_codes enable row level security;

create policy select_own
on pairing_codes
for select
using (
  auth.uid() = user_id
);

create function select_if_own_redemption_exists(p_code text) returns boolean as $$
  select exists (
    select 1
    from pairing_code_redemptions
    where pairing_code_redemptions.pairing_code = p_code
    and auth.uid() = pairing_code_redemptions.user_id
  )
$$ language sql security definer;

create policy select_if_own_redemption_exists
on pairing_codes
for select
using (
  select_if_own_redemption_exists(code)
);

create policy delete_own
on pairing_codes
for delete
using (
  auth.uid() = user_id
);

-- RLS for pairing_code_redemptions
alter table pairing_code_redemptions enable row level security;

create policy select_own
on pairing_code_redemptions
for select
using (
  auth.uid() = user_id
);

create function user_has_pairing_code(p_code text) returns boolean as $$
  select exists (
    select 1
    from pairing_codes
    where pairing_codes.code = p_code
    and auth.uid() = pairing_codes.user_id
  )
$$ language sql security definer;

create policy select_for_own_pairing_code
on pairing_code_redemptions
for select
using (
  user_has_pairing_code(pairing_code)
);

-- RLS for user_connections
alter table user_connections enable row level security;

create policy select_own
on user_connections
for select
using (
  auth.uid() = user_1_id or auth.uid() = user_2_id
);

create policy insert_if_matches_pairing_code_redemption
on user_connections
for insert
with check (
  exists (
    select 1
    from pairing_code_redemptions
    join pairing_codes on pairing_code_redemptions.pairing_code = pairing_codes.code
    where (
      (
        pairing_codes.user_id = user_1_id
        and pairing_code_redemptions.user_id = user_2_id
      )
    )
  )
);

create policy delete_own
on user_connections
for delete
using (
  auth.uid() = user_1_id or auth.uid() = user_2_id
);
