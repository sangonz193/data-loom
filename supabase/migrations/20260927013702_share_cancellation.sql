set
  local check_function_bodies = off;

alter table "public"."share_requests"
add column "cancelled_at" timestamp WITH time zone;

create or replace function public.ensure_share_request_open_for_response () RETURNS TRIGGER LANGUAGE plpgsql
set
  search_path to '' as $function$
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
$function$;

create trigger ensure_share_request_open_for_response
before insert on public.share_request_responses for each row
execute function public.ensure_share_request_open_for_response ();

grant
execute on FUNCTION "public"."ensure_share_request_open_for_response" () to PUBLIC,
"anon",
"authenticated",
"postgres",
"service_role";
