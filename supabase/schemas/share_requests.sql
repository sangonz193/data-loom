create table public.share_requests (
  id uuid primary key default gen_random_uuid(),
  from_person_id uuid not null references public.people (id) on delete cascade,
  from_device_id uuid not null references public.devices (id) on delete cascade,
  to_person_id uuid not null references public.people (id) on delete cascade,
  payload jsonb not null,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone not null default now(),
  check (expires_at > created_at)
);

create index share_requests_to_person_id_idx on public.share_requests (to_person_id);

create index share_requests_from_person_id_idx on public.share_requests (from_person_id);

create table public.share_request_responses (
  request_id uuid primary key references public.share_requests (id) on delete cascade,
  accepted boolean not null,
  accepted_by_device_id uuid references public.devices (id) on delete set null,
  created_at timestamp with time zone not null default now()
);

alter table public.share_requests enable row level security;

alter table public.share_request_responses enable row level security;
