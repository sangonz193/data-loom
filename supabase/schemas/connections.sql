create table public.connections (
  person_1_id uuid not null references public.people (id) on delete cascade,
  person_2_id uuid not null references public.people (id) on delete cascade,
  created_at timestamp with time zone not null default now(),
  primary key (person_1_id, person_2_id),
  check (person_1_id < person_2_id)
);

create index connections_person_2_id_idx on public.connections (person_2_id);

alter table public.connections enable row level security;
