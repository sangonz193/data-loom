create policy select_if_user_connection
on users
for select
using (
  exists (
    select 1
    from user_connections
    where (
      user_1_id = id
      or user_2_id = id
    )
    and (
      user_1_id = auth.uid()
      or user_2_id = auth.uid()
    )
  )
);

create table colors (
  id text primary key,
  label text not null
);

alter table colors enable row level security;

create policy select_all
on colors
for select
using (true);

insert into colors (id, label) values
('red', 'Red'),
('rose', 'Rose'),
('orange', 'Orange'),
('green', 'Green'),
('blue', 'Blue'),
('yellow', 'Yellow'),
('violet', 'Violet');

create table animals (
  id text primary key,
  label text not null,
  emoji text not null
);

alter table animals enable row level security;

create policy select_all
on animals
for select
using (true);

insert into animals (id, label, emoji) values
('bear', 'Bear', '🐻'),
('bee', 'Bee', '🐝'),
('bird', 'Bird', '🐦'),
('cat', 'Cat', '🐱'),
('dog', 'Dog', '🐶'),
('fish', 'Fish', '🐟'),
('rabbit', 'Rabbit', '🐰'),
('rat', 'Rat', '🐀'),
('snail', 'Snail', '🐌'),
('squirrel', 'Squirrel', '🐿️'),
('turtle', 'Turtle', '🐢');

alter table users
add column color_id text references colors(id),
add column animal_id text references animals(id);

update users
set color_id = (select id from colors order by random() limit 1),
    animal_id = (select id from animals order by random() limit 1);

create or replace function user_created()
returns trigger as $$
begin
  insert into public.users (id, created_at, color_id, animal_id)
  values (
    new.id,
    new.created_at,
    (select id from public.colors order by random() limit 1),
    (select id from public.animals order by random() limit 1)
  );
  return new;
end;
$$ language plpgsql security definer;
