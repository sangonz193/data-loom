set
  local check_function_bodies = off;

create or replace function public.complete_device_link (
  target_auth_user_id uuid,
  link_code text,
  source_device_id uuid,
  min_created_at timestamp with time zone
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
set
  search_path to ''
set
  lock_timeout to '3s' as $function$
declare
  target_person_id uuid;
  source_person_id uuid;
  source_auth_user_id uuid;
begin
  select people.id into target_person_id
  from public.people
  where people.auth_user_id = target_auth_user_id;

  if target_person_id is null then
    raise exception 'Link target not found' using errcode = 'PT403';
  end if;

  if not exists (
    select 1
    from auth.users
    where users.id = target_auth_user_id
      and users.is_anonymous = false
  ) then
    raise exception 'Link target must be a permanent account' using errcode = 'PT403';
  end if;

  select redemptions.from_person_id into source_person_id
  from public.pairing_codes as codes
  join public.pairing_code_redemptions as redemptions on redemptions.code = codes.code
  where codes.code = link_code
    and codes.purpose = 'device'
    and codes.person_id = target_person_id
    and codes.created_at >= min_created_at
  for update of codes;

  if source_person_id is null then
    raise exception 'Link code not found' using errcode = 'PT404';
  end if;

  if source_person_id = target_person_id then
    raise exception 'Link code redeemed by its owner' using errcode = 'PT403';
  end if;

  select people.auth_user_id into source_auth_user_id
  from public.people
  where people.id = source_person_id;

  perform 1
  from auth.users
  where users.id = source_auth_user_id
    and users.is_anonymous = true
  for update;

  if not found then
    raise exception 'Link source is no longer anonymous' using errcode = '55000';
  end if;

  perform 1 from public.people where people.id = target_person_id for no key update;

  perform 1 from public.people where people.id = source_person_id for update;

  perform 1
  from public.share_request_intents as intents
  where intents.from_person_id = source_person_id
  for update nowait;

  perform 1
  from public.devices
  where devices.person_id = source_person_id
  for update nowait;

  if not exists (
    select 1
    from public.devices
    where devices.id = source_device_id
      and devices.person_id = source_person_id
  ) then
    raise exception 'Link device not found' using errcode = 'PT403';
  end if;

  perform 1
  from public.share_requests as requests
  where source_person_id in (requests.from_person_id, requests.to_person_id)
  for update nowait;

  perform 1
  from public.connections
  where source_person_id in (connections.person_1_id, connections.person_2_id)
  for update nowait;

  perform 1
  from public.people
  where people.id in (
    select case
      when connections.person_1_id = source_person_id then connections.person_2_id
      else connections.person_1_id
    end
    from public.connections
    where source_person_id in (connections.person_1_id, connections.person_2_id)
  )
    and people.id <> target_person_id
  order by people.id
  for key share nowait;

  perform 1
  from public.pairing_codes as codes
  where codes.person_id = source_person_id
  for update nowait;

  perform 1
  from public.pairing_code_redemptions as redemptions
  where redemptions.from_person_id = source_person_id
    or redemptions.code in (
      select codes.code from public.pairing_codes as codes where codes.person_id = source_person_id
    )
  for update nowait;

  insert into public.share_request_intents as intent (from_person_id, request_id, cancelled_at)
  select target_person_id, intents.request_id, intents.cancelled_at
  from public.share_request_intents as intents
  where intents.from_person_id = source_person_id
  on conflict (from_person_id, request_id) do update
    set cancelled_at = coalesce(intent.cancelled_at, excluded.cancelled_at);

  update public.share_requests as requests
  set from_person_id = target_person_id
  where requests.from_person_id = source_person_id;

  update public.share_requests as requests
  set to_person_id = target_person_id
  where requests.to_person_id = source_person_id;

  update public.share_requests as requests
  set cancelled_at = merged.cancelled_at
  from public.share_request_intents as merged
  where merged.from_person_id = target_person_id
    and merged.request_id = requests.id
    and merged.cancelled_at is not null
    and requests.from_person_id = target_person_id
    and requests.cancelled_at is null
    and exists (
      select 1
      from public.share_request_intents as moved
      where moved.from_person_id = source_person_id
        and moved.request_id = requests.id
    );

  insert into public.connections (person_1_id, person_2_id)
  select least(target_person_id, other.id), greatest(target_person_id, other.id)
  from (
    select case
      when connections.person_1_id = source_person_id then connections.person_2_id
      else connections.person_1_id
    end as id
    from public.connections
    where source_person_id in (connections.person_1_id, connections.person_2_id)
  ) as other
  where other.id <> target_person_id
  order by other.id
  on conflict do nothing;

  update public.devices
  set person_id = target_person_id
  where devices.person_id = source_person_id;

  delete from public.pairing_codes as codes where codes.code = link_code;

  delete from auth.users where users.id = source_auth_user_id;
end;
$function$;

revoke all on FUNCTION "public"."complete_device_link" (uuid, text, uuid, timestamp WITH time zone)
from
  PUBLIC;

grant
execute on FUNCTION "public"."complete_device_link" (uuid, text, uuid, timestamp WITH time zone) to "postgres",
"service_role";
