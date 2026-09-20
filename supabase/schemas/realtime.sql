alter publication supabase_realtime
add table public.connections;

alter publication supabase_realtime
add table public.share_requests;

alter publication supabase_realtime
add table public.share_request_responses;

create policy "Devices can receive broadcasts" on realtime.messages for
select
  to authenticated using (
    realtime.messages.extension = 'broadcast'
    and exists (
      select
        1
      from
        public.devices
      where
        realtime.topic () = 'device:' || devices.id::text
        and devices.person_id = public.current_person_id ()
    )
  );
