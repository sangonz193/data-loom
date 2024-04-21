create table users (
  id uuid primary key,
  created_at timestamp with time zone
);

-- RLS
alter table users enable row level security;

create policy select_if_user
on users
for select
using (auth.uid() = id);


-- Trigger
create function user_created()
returns trigger as $$
begin
  insert into public.users (id, created_at)
  values (new.id, new.created_at);
  return new;
end;
$$ language plpgsql security definer;

create trigger user_created
  after insert on auth.users
  for each row
  execute function user_created();

-- Handle existing data
insert into users (id, created_at)
select id, created_at
from auth.users;
