create table public.share_requests (
  id uuid primary key default gen_random_uuid(),
  from_person_id uuid not null references public.people (id) on delete cascade,
  from_device_id uuid not null references public.devices (id) on delete cascade,
  to_person_id uuid not null references public.people (id) on delete cascade,
  payload jsonb not null,
  expires_at timestamp with time zone not null,
  cancelled_at timestamp with time zone,
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

create function public.ensure_share_request_open_for_response () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  perform 1
  from public.share_requests
  where id = new.request_id
    and cancelled_at is null
    and expires_at > now()
  for share;

  if not found then
    raise exception 'Share request cancelled or expired' using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger ensure_share_request_open_for_response
before insert on public.share_request_responses for each row
execute function public.ensure_share_request_open_for_response ();

alter table public.share_requests enable row level security;

alter table public.share_request_responses enable row level security;
