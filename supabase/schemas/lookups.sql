create table public.colors (id text primary key, label text not null);

create table public.animals (
  id text primary key,
  label text not null,
  emoji text not null
);

alter table public.colors enable row level security;

alter table public.animals enable row level security;

create policy "Anyone can read colors" on public.colors for
select
  to authenticated using (true);

create policy "Anyone can read animals" on public.animals for
select
  to authenticated using (true);
