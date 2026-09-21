create or replace function public.handle_new_auth_user () returns trigger language plpgsql security definer
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
