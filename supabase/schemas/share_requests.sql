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

create table public.share_request_intents (
  from_person_id uuid not null references public.people (id) on delete cascade,
  request_id uuid not null,
  cancelled_at timestamp with time zone,
  primary key (from_person_id, request_id)
);

alter table public.share_request_intents enable row level security;

create function public.ensure_share_request_not_cancelled () returns trigger language plpgsql
set
  search_path = '' as $$
declare
  cancellation_time timestamptz;
begin
  insert into public.share_request_intents (from_person_id, request_id)
  values (new.from_person_id, new.id)
  on conflict (from_person_id, request_id) do update
    set request_id = excluded.request_id
  returning cancelled_at into cancellation_time;

  if cancellation_time is not null then
    raise exception 'Share request cancelled' using errcode = '55000';
  end if;

  return new;
end;
$$;

create trigger ensure_share_request_not_cancelled
before insert on public.share_requests for each row
execute function public.ensure_share_request_not_cancelled ();

create function public.cancel_share_request (sender_id uuid, share_request_id uuid) returns table (id uuid, cancelled_at timestamp with time zone) language plpgsql
set
  search_path = '' as $$
declare
  cancellation_time timestamptz;
  request_owner uuid;
  saved_cancellation_time timestamptz;
begin
  insert into public.share_request_intents as intent (from_person_id, request_id, cancelled_at)
  values (sender_id, share_request_id, now())
  on conflict (from_person_id, request_id) do update
    set cancelled_at = coalesce(intent.cancelled_at, excluded.cancelled_at)
  returning intent.cancelled_at into cancellation_time;

  select request.from_person_id into request_owner
  from public.share_requests as request
  where request.id = share_request_id;

  if found and request_owner <> sender_id then
    raise exception 'Share request not found' using errcode = 'PT404';
  end if;

  update public.share_requests as request
  set cancelled_at = coalesce(request.cancelled_at, cancellation_time)
  where request.id = share_request_id and request.from_person_id = sender_id
  returning request.cancelled_at into saved_cancellation_time;

  return query select share_request_id, coalesce(saved_cancellation_time, cancellation_time);
end;
$$;

revoke
execute on function public.cancel_share_request (uuid, uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.cancel_share_request (uuid, uuid) to service_role;

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
