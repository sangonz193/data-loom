create table public.pairing_codes (
  code text primary key,
  person_id uuid not null references public.people (id) on delete cascade,
  purpose text not null check (purpose in ('device', 'connection')),
  created_at timestamp with time zone not null default now(),
  unique (person_id, purpose)
);

create table public.pairing_code_redemptions (
  code text primary key references public.pairing_codes (code) on delete cascade,
  from_person_id uuid not null references public.people (id) on delete cascade,
  created_at timestamp with time zone not null default now()
);

create index pairing_code_redemptions_from_person_id_idx on public.pairing_code_redemptions (from_person_id);

alter table public.pairing_codes enable row level security;

alter table public.pairing_code_redemptions enable row level security;
