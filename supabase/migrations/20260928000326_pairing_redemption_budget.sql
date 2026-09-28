set
  local check_function_bodies = off;

create table "public"."pairing_redemption_failures" (
  "id" bigint generated always as identity not null,
  "person_id" uuid not null,
  "client_prefix" cidr not null,
  "created_at" timestamp with time zone not null default clock_timestamp(),
  constraint "pairing_redemption_failures_pkey" primary key (id)
);

alter table "public"."pairing_redemption_failures" ENABLE row LEVEL SECURITY;

create or replace function public.redeem_pairing_code (
  redeemer_id uuid,
  client_ip inet,
  pairing_code text,
  pairing_purpose text,
  ttl_seconds integer
) RETURNS table (outcome text, owner_person_id uuid) LANGUAGE plpgsql
set
  search_path to ''
set
  lock_timeout to '3s' as $function$
declare
  prefix cidr;
  checked_at timestamptz;
  code_row public.pairing_codes%rowtype;
  redeemed_by uuid;
begin
  if redeemer_id is null or client_ip is null
    or pairing_code is null or length(pairing_code) not between 1 and 32
    or pairing_purpose is null or pairing_purpose not in ('connection', 'device')
    or ttl_seconds is null or ttl_seconds <= 0
    or masklen(client_ip) <> (case when family(client_ip) = 4 then 32 else 128 end) then
    raise exception 'Invalid redemption input' using errcode = '22023';
  end if;

  if family(client_ip) = 6 and client_ip <<= '::ffff:0:0/96'::inet then
    client_ip := '0.0.0.0'::inet + (client_ip - '::ffff:0:0'::inet);
  end if;
  prefix := network(set_masklen(client_ip, case when family(client_ip) = 4 then 32 else 64 end));

  perform pg_advisory_xact_lock(74101, hashtext(redeemer_id::text));
  perform pg_advisory_xact_lock(74102, hashtext(prefix::text));
  if not exists (select 1 from public.people where id = redeemer_id) then
    return query select 'person_missing'::text, null::uuid;
    return;
  end if;
  checked_at := clock_timestamp();
  if (select count(*) from public.pairing_redemption_failures
      where person_id = redeemer_id and created_at > checked_at - interval '15 minutes') >= 10
    or (select count(*) from public.pairing_redemption_failures
      where client_prefix = prefix and created_at > checked_at - interval '15 minutes') >= 30 then
    return query select 'limited'::text, null::uuid;
    return;
  end if;

  select * into code_row from public.pairing_codes
    where code = pairing_code for no key update;
  perform 1 from public.people where id = redeemer_id for key share;
  if not found then
    return query select 'person_missing'::text, null::uuid;
    return;
  end if;
  select from_person_id into redeemed_by from public.pairing_code_redemptions
    where code = pairing_code for update;
  checked_at := clock_timestamp();

  if code_row.code is null or code_row.purpose <> pairing_purpose
    or code_row.created_at < checked_at - make_interval(secs => ttl_seconds) then
    outcome := 'not_found';
  elsif code_row.person_id = redeemer_id then
    return query select 'forbidden'::text, null::uuid;
    return;
  elsif redeemed_by is not null and redeemed_by <> redeemer_id then
    outcome := 'forbidden';
  else
    if redeemed_by is null then
      insert into public.pairing_code_redemptions (code, from_person_id, created_at)
        values (pairing_code, redeemer_id, checked_at);
    end if;
    return query select 'success'::text, code_row.person_id;
    return;
  end if;

  if code_row.person_id is distinct from redeemer_id then
    insert into public.pairing_redemption_failures (person_id, client_prefix, created_at)
      values (redeemer_id, prefix, checked_at);
  end if;
  return query select outcome, null::uuid;
end;
$function$;

create index pairing_redemption_failures_person_time_idx on public.pairing_redemption_failures using btree (person_id, created_at);

create index pairing_redemption_failures_prefix_time_idx on public.pairing_redemption_failures using btree (client_prefix, created_at);

create index pairing_redemption_failures_time_idx on public.pairing_redemption_failures using btree (created_at);

revoke all on FUNCTION "public"."redeem_pairing_code" (uuid, inet, text, text, integer)
from
  PUBLIC;

grant
execute on FUNCTION "public"."redeem_pairing_code" (uuid, inet, text, text, integer) to "postgres",
"service_role";

grant DELETE,
INSERT,
MAINTAIN,
references,
select
,
  TRIGGER,
truncate,
update on table "public"."pairing_redemption_failures" to "postgres",
"service_role";
