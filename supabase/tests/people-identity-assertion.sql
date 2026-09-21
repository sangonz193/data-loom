do $$
declare
  has_identity boolean;
begin
  insert into
    auth.users (
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    )
  values
    (
      '00000000-0000-0000-0000-000000000003',
      'authenticated',
      'authenticated',
      'identity@example.com',
      '',
      now(),
      '{}',
      '{}',
      now(),
      now()
    );

  select
    color_id is not null
    and animal_id is not null
  into
    has_identity
  from
    public.people
  where
    auth_user_id = '00000000-0000-0000-0000-000000000003';

  if has_identity is distinct from true then
    raise exception 'new people must receive color and animal identities';
  end if;
end;
$$;
