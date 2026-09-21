with
  inserted_users as (
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
        '00000000-0000-0000-0000-000000000001',
        'authenticated',
        'authenticated',
        'first@example.com',
        '',
        now(),
        '{}',
        '{}',
        now(),
        now()
      ),
      (
        '00000000-0000-0000-0000-000000000002',
        'authenticated',
        'authenticated',
        'second@example.com',
        '',
        now(),
        '{}',
        '{}',
        now(),
        now()
      )
    returning
      id
  )
insert into
  public.user_connections (user_1_id, user_2_id, created_at)
select
  legacy_connections.user_1_id,
  legacy_connections.user_2_id,
  now()
from
  (
    values
      (
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000002'::uuid
      ),
      (
        '00000000-0000-0000-0000-000000000002'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid
      )
  ) as legacy_connections (user_1_id, user_2_id)
  cross join (
    select
      count(*)
    from
      inserted_users
  ) as inserted_user_count;
