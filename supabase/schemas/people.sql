create table public.people (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users (id) on delete cascade,
  color_id text references public.colors (id),
  animal_id text references public.animals (id),
  created_at timestamp with time zone not null default now()
);

alter table public.people enable row level security;
