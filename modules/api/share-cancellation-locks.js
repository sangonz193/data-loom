import { SQL } from "bun"

export async function holdShareChange(
  databaseUrl,
  requestId,
  operation,
  deviceId,
) {
  const sql = new SQL(databaseUrl)
  let release
  let acquired
  let fail
  let holderPid
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const ready = new Promise((resolve, reject) => {
    acquired = resolve
    fail = reject
  })
  const transaction = sql
    .begin(async (tx) => {
      const [{ pid }] = await tx`select pg_backend_pid()::int as pid`
      holderPid = pid
      if (operation === "cancel") {
        await tx`select id from public.share_requests where id = ${requestId} for update`
        acquired()
        await gate
        await tx`update public.share_requests set cancelled_at = now() where id = ${requestId}`
      } else {
        await tx`insert into public.share_request_responses (request_id, accepted, accepted_by_device_id) values (${requestId}, true, ${deviceId})`
        acquired()
        await gate
      }
    })
    .catch((error) => {
      fail(error)
      throw error
    })
  await ready

  return {
    waitForBlocked: async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [{ blocked }] =
          await sql`select count(*)::int as blocked from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`
        if (blocked > 0) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("Expected a blocked database operation")
    },
    release: async () => {
      release()
      try {
        await transaction
      } finally {
        await sql.close()
      }
    },
  }
}
