select
  1 / (
    select
      (count(*) = 1)::int
    from
      public.connections
    where
      person_1_id = '00000000-0000-0000-0000-000000000001'
      and person_2_id = '00000000-0000-0000-0000-000000000002'
  );
