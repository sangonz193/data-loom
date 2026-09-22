create function public.current_person_id () returns uuid language sql stable security definer
set
  search_path = '' as $$
  select people.id
  from public.people
  where people.auth_user_id = auth.uid()
$$;

create function public.people_are_connected (other_person_id uuid) returns boolean language sql stable security definer
set
  search_path = '' as $$
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
$$;

create function public.can_access_share_request (share_request_id uuid) returns boolean language sql stable security definer
set
  search_path = '' as $$
  select exists (
    select 1
    from public.share_requests
    where share_requests.id = share_request_id
    and public.current_person_id() in (
      share_requests.from_person_id,
      share_requests.to_person_id
    )
  )
$$;

create function public.handle_new_auth_user () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  insert into public.people (auth_user_id, created_at, color_id, animal_id)
  values (
    new.id,
    new.created_at,
    (select id from public.colors order by random() limit 1),
    (select id from public.animals order by random() limit 1)
  );

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users for each row
execute function public.handle_new_auth_user ();

create policy "People can read themselves and connections" on public.people for
select
  to authenticated using (
    id = public.current_person_id ()
    or public.people_are_connected (id)
  );

create policy "People can read their devices" on public.devices for
select
  to authenticated using (person_id = public.current_person_id ());

create policy "People can read their connections" on public.connections for
select
  to authenticated using (
    person_1_id = public.current_person_id ()
    or person_2_id = public.current_person_id ()
  );

create policy "People can read their pairing codes" on public.pairing_codes for
select
  to authenticated using (person_id = public.current_person_id ());

create policy "People can read their share requests" on public.share_requests for
select
  to authenticated using (
    from_person_id = public.current_person_id ()
    or to_person_id = public.current_person_id ()
  );

create policy "People can read their share request responses" on public.share_request_responses for
select
  to authenticated using (public.can_access_share_request (request_id));
