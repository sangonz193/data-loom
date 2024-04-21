create table file_sharing_request (
  id uuid primary key default uuid_generate_v4(),
  from_user_id uuid not null references users(id) on delete cascade,
  to_user_id uuid not null references users(id) on delete cascade,
  payload jsonb not null,
  created_at timestamp with time zone default now() not null
);

alter table file_sharing_request enable row level security;
alter publication supabase_realtime add table file_sharing_request;

create policy select_if_own
on file_sharing_request
for select
using (from_user_id = auth.uid());

create policy select_if_to_user
on file_sharing_request
for select
using (to_user_id = auth.uid());

create policy insert_if_from_user
on file_sharing_request
as restrictive
for insert
with check (
  from_user_id = auth.uid()
);

create policy insert_if_to_connection
on file_sharing_request
as restrictive
for insert
with check (
  exists (
    select 1
    from user_connections
    where (
      user_1_id = auth.uid()
      and user_2_id = to_user_id
    )
    or (
      user_1_id = to_user_id
      and user_2_id = auth.uid()
    )
  )
);

create policy insert_permissive
on file_sharing_request
for insert
with check (true);

create policy delete_if_own
on file_sharing_request
for delete
using (from_user_id = auth.uid());

create table file_sharing_request_response (
  request_id uuid primary key references file_sharing_request(id) on delete cascade,
  accepted boolean not null,
  created_at timestamp with time zone default now() not null
);

alter table file_sharing_request_response enable row level security;
alter publication supabase_realtime add table file_sharing_request_response;

create policy select_if_own
on file_sharing_request_response
for select
using (
  auth.uid() = (
    select to_user_id
    from file_sharing_request
    where id = request_id
  )
);

create policy select_if_request_owner
on file_sharing_request_response
for select
using (
  auth.uid() = (
    select from_user_id
    from file_sharing_request
    where id = request_id
  )
);

create policy insert_if_request_to_user
on file_sharing_request_response
as restrictive
for insert
with check (
  auth.uid() = (
    select to_user_id
    from file_sharing_request
    where id = request_id
  )
);

create policy insert_permissive
on file_sharing_request_response
for insert
with check (true);
