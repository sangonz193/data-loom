-- Pairing rows are transient; clearing them lets the NOT NULL columns below be added.
truncate table "public"."pairing_code_redemptions",
"public"."pairing_codes";

set
  local check_function_bodies = off;

alter publication "supabase_realtime"
drop table "public"."file_sharing_request_response";

alter publication "supabase_realtime"
drop table "public"."file_sharing_request";

alter publication "supabase_realtime"
drop table "public"."pairing_code_redemptions";

alter publication "supabase_realtime"
drop table "public"."user_connections";

alter publication "supabase_realtime"
drop table "public"."web_rtc_signals";

drop policy "select_all" on "public"."animals";

drop policy "select_all" on "public"."colors";

drop policy "insert_if_to_connection" on "public"."file_sharing_request";

drop policy "insert_if_request_to_user" on "public"."file_sharing_request_response";

drop policy "select_if_own" on "public"."file_sharing_request_response";

drop policy "select_if_request_owner" on "public"."file_sharing_request_response";

drop policy "select_for_own_pairing_code" on "public"."pairing_code_redemptions";

drop policy "select_own" on "public"."pairing_code_redemptions";

drop policy "delete_own" on "public"."pairing_codes";

drop policy "select_if_own_redemption_exists" on "public"."pairing_codes";

drop policy "select_own" on "public"."pairing_codes";

drop policy "insert_if_matches_pairing_code_redemption" on "public"."user_connections";

drop policy "select_if_user_connection" on "public"."users";

drop policy "insert_if_code_redemption_exists" on "public"."web_rtc_signals";

drop policy "insert_if_user_connection_exists" on "public"."web_rtc_signals";

drop trigger "user_created" on "auth"."users";

alter table "public"."file_sharing_request"
drop constraint "file_sharing_request_from_user_id_fkey";

alter table "public"."file_sharing_request"
drop constraint "file_sharing_request_to_user_id_fkey";

alter table "public"."file_sharing_request_response"
drop constraint "file_sharing_request_response_request_id_fkey";

alter table "public"."pairing_code_redemptions"
drop constraint "pairing_code_redemptions_pairing_code_fkey";

alter table "public"."pairing_code_redemptions"
drop constraint "pairing_code_redemptions_pkey";

alter table "public"."pairing_code_redemptions"
drop constraint "pairing_code_redemptions_user_id_fkey";

alter table "public"."pairing_codes"
drop constraint "pairing_codes_user_id_fkey";

alter table "public"."user_connections"
drop constraint "user_connections_user_1_id_fkey";

alter table "public"."user_connections"
drop constraint "user_connections_user_2_id_fkey";

alter table "public"."users"
drop constraint "users_animal_id_fkey";

alter table "public"."users"
drop constraint "users_color_id_fkey";

alter table "public"."web_rtc_signals"
drop constraint "web_rtc_signals_from_user_id_fkey";

alter table "public"."web_rtc_signals"
drop constraint "web_rtc_signals_to_user_id_fkey";

drop function "public"."insert_if_code_redemption_exists" (uuid);

drop function "public"."select_if_own_redemption_exists" (text);

drop function "public"."user_created" ();

drop function "public"."user_has_pairing_code" (text);

alter table "public"."pairing_code_redemptions"
drop column "pairing_code";

alter table "public"."pairing_code_redemptions"
drop column "user_id";

alter table "public"."pairing_codes"
drop column "user_id";

drop table "public"."file_sharing_request_response";

drop table "public"."file_sharing_request";

drop table "public"."user_connections";

drop table "public"."users";

drop table "public"."web_rtc_signals";

create table "public"."connections" (
  "person_1_id" uuid not null,
  "person_2_id" uuid not null,
  "created_at" timestamp with time zone not null default now(),
  constraint "connections_check" check ((person_1_id < person_2_id)),
  constraint "connections_pkey" primary key (person_1_id, person_2_id)
);

alter table "public"."connections" ENABLE row LEVEL SECURITY;

create table "public"."devices" (
  "id" uuid not null,
  "person_id" uuid not null,
  "name" text not null,
  "last_seen_at" timestamp with time zone not null default now(),
  constraint "devices_pkey" primary key (id)
);

alter table "public"."devices" ENABLE row LEVEL SECURITY;

create table "public"."people" (
  "id" uuid not null default gen_random_uuid(),
  "auth_user_id" uuid not null,
  "color_id" text,
  "animal_id" text,
  "created_at" timestamp with time zone not null default now(),
  constraint "people_auth_user_id_key" unique (auth_user_id),
  constraint "people_pkey" primary key (id)
);

alter table "public"."people" ENABLE row LEVEL SECURITY;

create table "public"."share_request_responses" (
  "request_id" uuid not null,
  "accepted" boolean not null,
  "accepted_by_device_id" uuid,
  "created_at" timestamp with time zone not null default now(),
  constraint "share_request_responses_pkey" primary key (request_id)
);

alter table "public"."share_request_responses" ENABLE row LEVEL SECURITY;

create table "public"."share_requests" (
  "id" uuid not null default gen_random_uuid(),
  "from_person_id" uuid not null,
  "from_device_id" uuid not null,
  "to_person_id" uuid not null,
  "payload" jsonb not null,
  "expires_at" timestamp with time zone not null,
  "created_at" timestamp with time zone not null default now(),
  constraint "share_requests_check" check ((expires_at > created_at)),
  constraint "share_requests_pkey" primary key (id)
);

alter table "public"."share_requests" ENABLE row LEVEL SECURITY;

alter table "public"."pairing_code_redemptions"
add column "code" text not null;

alter table "public"."pairing_code_redemptions"
add column "from_person_id" uuid not null;

alter table "public"."pairing_codes"
add column "person_id" uuid not null;

alter table "public"."pairing_codes"
add column "purpose" text not null;

create or replace function public.can_access_share_request (share_request_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
set
  search_path to '' as $function$
  select exists (
    select 1
    from public.share_requests
    where share_requests.id = share_request_id
    and public.current_person_id() in (
      share_requests.from_person_id,
      share_requests.to_person_id
    )
  )
$function$;

create or replace function public.current_person_id () RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
set
  search_path to '' as $function$
  select people.id
  from public.people
  where people.auth_user_id = auth.uid()
$function$;

create or replace function public.handle_new_auth_user () RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
set
  search_path to '' as $function$
begin
  insert into public.people (auth_user_id)
  values (new.id);

  return new;
end;
$function$;

create or replace function public.people_are_connected (other_person_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
set
  search_path to '' as $function$
  select exists (
    select 1
    from public.connections
    where (
      connections.person_1_id = public.current_person_id()
      and connections.person_2_id = other_person_id
    ) or (
      connections.person_2_id = public.current_person_id()
      and connections.person_1_id = other_person_id
    )
  )
$function$;

alter table "public"."pairing_code_redemptions"
add constraint "pairing_code_redemptions_code_fkey" foreign KEY (code) references public.pairing_codes (code) on delete cascade;

alter table "public"."pairing_code_redemptions"
add constraint "pairing_code_redemptions_pkey" primary key (code);

alter table "public"."pairing_codes"
add constraint "pairing_codes_person_id_purpose_key" unique (person_id, purpose);

alter table "public"."pairing_codes"
add constraint "pairing_codes_purpose_check" check (
  (
    purpose = any (array['device'::text, 'connection'::text])
  )
);

alter table "public"."people"
add constraint "people_animal_id_fkey" foreign KEY (animal_id) references public.animals (id);

alter table "public"."people"
add constraint "people_auth_user_id_fkey" foreign KEY (auth_user_id) references auth.users (id) on delete cascade;

alter table "public"."people"
add constraint "people_color_id_fkey" foreign KEY (color_id) references public.colors (id);

alter table "public"."connections"
add constraint "connections_person_1_id_fkey" foreign KEY (person_1_id) references public.people (id) on delete cascade;

alter table "public"."connections"
add constraint "connections_person_2_id_fkey" foreign KEY (person_2_id) references public.people (id) on delete cascade;

alter table "public"."devices"
add constraint "devices_person_id_fkey" foreign KEY (person_id) references public.people (id) on delete cascade;

alter table "public"."pairing_code_redemptions"
add constraint "pairing_code_redemptions_from_person_id_fkey" foreign KEY (from_person_id) references public.people (id) on delete cascade;

alter table "public"."pairing_codes"
add constraint "pairing_codes_person_id_fkey" foreign KEY (person_id) references public.people (id) on delete cascade;

alter table "public"."share_request_responses"
add constraint "share_request_responses_accepted_by_device_id_fkey" foreign KEY (accepted_by_device_id) references public.devices (id) on delete set null;

alter table "public"."share_requests"
add constraint "share_requests_from_device_id_fkey" foreign KEY (from_device_id) references public.devices (id) on delete cascade;

alter table "public"."share_requests"
add constraint "share_requests_from_person_id_fkey" foreign KEY (from_person_id) references public.people (id) on delete cascade;

alter table "public"."share_request_responses"
add constraint "share_request_responses_request_id_fkey" foreign KEY (request_id) references public.share_requests (id) on delete cascade;

alter table "public"."share_requests"
add constraint "share_requests_to_person_id_fkey" foreign KEY (to_person_id) references public.people (id) on delete cascade;

create index connections_person_2_id_idx on public.connections using btree (person_2_id);

create index devices_person_id_idx on public.devices using btree (person_id);

create index pairing_code_redemptions_from_person_id_idx on public.pairing_code_redemptions using btree (from_person_id);

create index share_requests_from_person_id_idx on public.share_requests using btree (from_person_id);

create index share_requests_to_person_id_idx on public.share_requests using btree (to_person_id);

create trigger on_auth_user_created
after insert on auth.users for each row
execute function public.handle_new_auth_user ();

create policy "Anyone can read animals" on "public"."animals" for
select
  to "authenticated" using (true);

create policy "Anyone can read colors" on "public"."colors" for
select
  to "authenticated" using (true);

create policy "People can read their connections" on "public"."connections" for
select
  to "authenticated" using (
    (
      (person_1_id = public.current_person_id ())
      or (person_2_id = public.current_person_id ())
    )
  );

create policy "People can read their devices" on "public"."devices" for
select
  to "authenticated" using ((person_id = public.current_person_id ()));

create policy "People can read their pairing codes" on "public"."pairing_codes" for
select
  to "authenticated" using ((person_id = public.current_person_id ()));

create policy "People can read themselves and connections" on "public"."people" for
select
  to "authenticated" using (
    (
      (id = public.current_person_id ())
      or public.people_are_connected (id)
    )
  );

create policy "People can read their share request responses" on "public"."share_request_responses" for
select
  to "authenticated" using (public.can_access_share_request (request_id));

create policy "People can read their share requests" on "public"."share_requests" for
select
  to "authenticated" using (
    (
      (from_person_id = public.current_person_id ())
      or (to_person_id = public.current_person_id ())
    )
  );

create policy "Devices can receive broadcasts" on "realtime"."messages" for
select
  to "authenticated" using (
    (
      (EXTENSION = 'broadcast'::text)
      and (
        exists (
          select
            1
          from
            public.devices
          where
            (
              (
                realtime.topic () = ('device:'::text || (devices.id)::text)
              )
              and (devices.person_id = public.current_person_id ())
            )
        )
      )
    )
  );

alter publication "supabase_realtime"
add table "public"."connections";

alter publication "supabase_realtime"
add table "public"."share_request_responses";

alter publication "supabase_realtime"
add table "public"."share_requests";

grant
execute on FUNCTION "public"."can_access_share_request" (uuid) to PUBLIC,
"anon",
"authenticated",
"postgres",
"service_role";

grant
execute on FUNCTION "public"."current_person_id" () to PUBLIC,
"anon",
"authenticated",
"postgres",
"service_role";

grant
execute on FUNCTION "public"."handle_new_auth_user" () to PUBLIC,
"anon",
"authenticated",
"postgres",
"service_role";

grant
execute on FUNCTION "public"."people_are_connected" (uuid) to PUBLIC,
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
update on table "public"."connections" to "anon",
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
update on table "public"."devices" to "anon",
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
update on table "public"."people" to "anon",
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
update on table "public"."share_request_responses" to "anon",
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
update on table "public"."share_requests" to "anon",
"authenticated",
"postgres",
"service_role";
