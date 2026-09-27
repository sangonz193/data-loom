import { SQL } from "bun"

export async function holdShareIntent(databaseUrl, operation, request) {
  const sql = new SQL(databaseUrl)
  const gate = Promise.withResolvers()
  const ready = Promise.withResolvers()
  let holderPid

  if (operation === "delay-create") {
    await sql.unsafe(`
      create function public.delay_share_insert_test() returns trigger
      language plpgsql as $$
      begin
        if new.id = '${request.id}'::uuid then
          perform pg_advisory_xact_lock(hashtextextended(new.id::text, 0));
        end if;
        return new;
      end;
      $$;
      create trigger delay_share_insert_test before insert on public.share_requests
      for each row execute function public.delay_share_insert_test();
    `)
  }

  const transaction = sql
    .begin(async (tx) => {
      const [{ pid }] = await tx`select pg_backend_pid()::int as pid`
      holderPid = pid
      if (operation === "delay-create") {
        await tx`select pg_advisory_xact_lock(hashtextextended(${request.id}::text, 0))`
      } else if (operation === "cancel") {
        await tx`select * from public.cancel_share_request(${request.from_person_id}::uuid, ${request.id}::uuid)`
      } else {
        await tx`insert into public.share_requests ${tx(request)}`
      }
      ready.resolve()
      await gate.promise
    })
    .catch((error) => {
      ready.reject(error)
      throw error
    })
  await ready.promise

  return {
    waitForBlocked: async (count = 1) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const [{ blocked }] =
          await sql`select count(*)::int as blocked from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`
        if (blocked >= count) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("Expected blocked share operations")
    },
    release: async () => {
      gate.resolve()
      await transaction
    },
    close: async () => {
      try {
        if (operation === "delay-create") {
          await sql`drop trigger delay_share_insert_test on public.share_requests`
          await sql`drop function public.delay_share_insert_test()`
        }
      } finally {
        await sql.close()
      }
    },
  }
}
