set
  local check_function_bodies = off;

create table "public"."share_request_intents" (
  "from_person_id" uuid not null,
  "request_id" uuid not null,
  "cancelled_at" timestamp with time zone,
  constraint "share_request_intents_pkey" primary key (from_person_id, request_id)
);

alter table "public"."share_request_intents" ENABLE row LEVEL SECURITY;

create or replace function public.cancel_share_request (sender_id uuid, share_request_id uuid) RETURNS table (id uuid, cancelled_at timestamp with time zone) LANGUAGE plpgsql
set
  search_path to '' as $function$
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
$function$;

create or replace function public.ensure_share_request_not_cancelled () RETURNS TRIGGER LANGUAGE plpgsql
set
  search_path to '' as $function$
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
$function$;

alter table "public"."share_request_intents"
add constraint "share_request_intents_from_person_id_fkey" foreign KEY (from_person_id) references public.people (id) on delete cascade;

create trigger ensure_share_request_not_cancelled
before insert on public.share_requests for each row
execute function public.ensure_share_request_not_cancelled ();

revoke all on FUNCTION "public"."cancel_share_request" (uuid, uuid)
from
  PUBLIC;

grant
execute on FUNCTION "public"."cancel_share_request" (uuid, uuid) to "postgres",
"service_role";

grant
execute on FUNCTION "public"."ensure_share_request_not_cancelled" () to PUBLIC,
"anon",
"authenticated",
"postgres",
"service_role";

grant DELETE,
INSERT,
MAINTAIN,
references,
select
,
  TRIGGER,
truncate,
update on table "public"."share_request_intents" to "anon",
"authenticated",
"postgres",
"service_role";
