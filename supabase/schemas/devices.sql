create table public.devices (
  id uuid primary key,
  person_id uuid not null references public.people (id) on delete cascade,
  name text not null,
  last_seen_at timestamp with time zone not null default now()
);

create index devices_person_id_idx on public.devices (person_id);

alter table public.devices enable row level security;
