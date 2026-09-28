import { expect, test } from "bun:test"

import { createAdminClient } from "@/utils/supabase/admin"

import { trustedClientIp } from "./client-ip"
import { holdDeviceLinkRows, queryDatabase } from "./device-link-locks"
import { fixtureClientIp } from "./fixture-client-ip"
import { appRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

async function fixture() {
  const admin = createAdminClient()
  const db = process.env.DB_URL!
  const users = await Promise.all(
    Array.from({ length: 6 }, async () => {
      const { data, error } = await admin.auth.admin.createUser({
        email: `limit-${crypto.randomUUID()}@example.test`,
        email_confirm: true,
      })
      if (error || !data.user) throw error ?? new Error("Missing user")
      const { data: person, error: personError } = await admin
        .from("people")
        .select("id")
        .eq("auth_user_id", data.user.id)
        .single()
      if (personError) throw personError
      return { authId: data.user.id, personId: person.id }
    }),
  )
  const ip = fixtureClientIp()
  const sql = (text: string, params: unknown[] = []) =>
    queryDatabase(
      db,
      text,
      params.map((value) =>
        Array.isArray(value) ? `{${value.join(",")}}` : value,
      ),
    )
  const caller = (index: number, clientIp: string | null = ip) =>
    appRouter.createCaller({ userId: users[index]!.authId, clientIp })
  const rpc = async (
    index: number,
    clientIp = ip,
    code = "MISSING",
    ttl = 300,
  ) => {
    const { data, error } = await admin
      .rpc("redeem_pairing_code", {
        redeemer_id: users[index]!.personId,
        client_ip: clientIp,
        pairing_code: code,
        pairing_purpose: "connection",
        ttl_seconds: ttl,
      })
      .single()
    if (error) throw error
    return data.outcome
  }
  return {
    admin,
    db,
    users,
    ip,
    sql,
    caller,
    rpc,
    async count(index?: number) {
      const [row] = await sql(
        "select count(*)::int as n from public.pairing_redemption_failures where person_id = any($1::uuid[])",
        [
          index === undefined ?
            users.map((u) => u.personId)
          : [users[index]!.personId],
        ],
      )
      return row.n
    },
    async close() {
      await Promise.all(users.map((u) => admin.auth.admin.deleteUser(u.authId)))
      await sql(
        "delete from public.pairing_redemption_failures where person_id = any($1::uuid[])",
        [users.map((u) => u.personId)],
      )
    },
  }
}

integrationTest(
  "shared redemption budget charges only failed codes, blocks valid codes, and recovers",
  async () => {
    const f = await fixture()
    try {
      await f.sql("update auth.users set is_anonymous = true where id = $1", [
        f.users[1]!.authId,
      ])
      const owner = f.caller(0),
        source = f.caller(1)
      const connection = await owner.pairing.create({ purpose: "connection" })
      const device = await owner.pairing.create({ purpose: "device" })
      await expect(
        owner.pairing.redeem({ code: connection.code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        owner.devices.link({ code: device.code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await f.sql("update auth.users set is_anonymous = true where id = $1", [
        f.users[0]!.authId,
      ])
      await expect(
        owner.devices.link({ code: device.code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await f.sql("update auth.users set is_anonymous = false where id = $1", [
        f.users[0]!.authId,
      ])
      await expect(source.pairing.redeem({ code: "" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      })
      await expect(
        appRouter
          .createCaller({ userId: null, clientIp: f.ip })
          .pairing.redeem({ code: "MISSING" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      await expect(
        appRouter
          .createCaller({ userId: crypto.randomUUID(), clientIp: f.ip })
          .pairing.redeem({ code: "MISSING" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      for (const procedure of ["pairing", "devices"] as const) {
        const noIp = f.caller(
          1,
          trustedClientIp(
            new Headers({ "x-forwarded-for": f.ip }),
            "production",
            "1",
          ),
        )
        await expect(
          procedure === "pairing" ?
            noIp.pairing.redeem({ code: connection.code })
          : noIp.devices.link({ code: device.code }),
        ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" })
      }
      await source.pairing.redeem({ code: connection.code })
      await source.pairing.redeem({ code: connection.code })
      await source.devices.link({ code: device.code })
      await source.devices.link({ code: device.code })
      expect(await f.count()).toBe(0)
      await expect(
        f.caller(2).pairing.redeem({ code: connection.code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect(await f.count(2)).toBe(1)
      await f.sql("update auth.users set is_anonymous = true where id = $1", [
        f.users[2]!.authId,
      ])
      await expect(
        f.caller(2).devices.link({ code: device.code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect(await f.count(2)).toBe(2)
      await expect(
        source.pairing.redeem({ code: device.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(
        source.devices.link({ code: connection.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await f.sql(
        "update public.pairing_codes set created_at = now() - interval '6 minutes' where person_id = $1",
        [f.users[0]!.personId],
      )
      await expect(
        owner.pairing.redeem({ code: device.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(
        owner.pairing.redeem({ code: connection.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      expect(await f.count(0)).toBe(0)
      await expect(
        source.pairing.redeem({ code: connection.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(
        source.devices.link({ code: device.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      for (let i = 0; i < 6; i++)
        await expect(
          i % 2 ?
            source.pairing.redeem({ code: "MISSING" })
          : source.devices.link({ code: "MISSING" }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" })
      expect(await f.count(1)).toBe(10)
      const fresh = await owner.pairing.create({ purpose: "connection" })
      await expect(
        source.pairing.redeem({ code: fresh.code }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" })
      await expect(
        source.devices.link({ code: "MISSING" }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" })
      expect(await f.count(1)).toBe(10)
      await f.sql(
        "update public.pairing_redemption_failures set created_at = now() - interval '16 minutes' where person_id = $1",
        [f.users[1]!.personId],
      )
      expect(await source.pairing.redeem({ code: fresh.code })).toEqual({
        remotePersonId: f.users[0]!.personId,
      })
      const [{ n }] = await f.sql(
        "select count(*)::int as n from public.pairing_code_redemptions where code = $1",
        [fresh.code],
      )
      expect(n).toBe(1)
    } finally {
      await f.close()
    }
  },
)

integrationTest(
  "concurrent person and IPv6 /64 budgets serialize exactly and survive person deletion",
  async () => {
    const f = await fixture()
    try {
      const person = await Promise.all(
        Array.from({ length: 15 }, () => f.rpc(0)),
      )
      expect(person.filter((x) => x === "not_found")).toHaveLength(10)
      expect(person.filter((x) => x === "limited")).toHaveLength(5)
      const prefix = f.ip.replace(/::1$/, "::abcd")
      const others = await Promise.all(
        Array.from({ length: 25 }, (_, i) => f.rpc(1 + (i % 4), prefix)),
      )
      expect(others.filter((x) => x === "not_found")).toHaveLength(20)
      expect(others.filter((x) => x === "limited")).toHaveLength(5)
      expect(await f.count()).toBe(30)
      const { error } = await f.admin.auth.admin.deleteUser(f.users[0]!.authId)
      if (error) throw error
      expect(await f.count()).toBe(30)
      expect(await f.rpc(5)).toBe("limited")
      expect(await f.rpc(5, fixtureClientIp())).toBe("not_found")
      const { data, error: missingError } = await f.admin
        .rpc("redeem_pairing_code", {
          redeemer_id: f.users[0]!.personId,
          client_ip: f.ip,
          pairing_code: "MISSING",
          pairing_purpose: "connection",
          ttl_seconds: 300,
        })
        .single()
      if (missingError) throw missingError
      expect(data.outcome).toBe("person_missing")
      expect(await f.count(0)).toBe(10)
    } finally {
      await f.close()
    }
  },
)

integrationTest(
  "IPv4 mapped forms aggregate with IPv4 /32 and leave other addresses independent",
  async () => {
    const f = await fixture()
    const ip = "192.0.2.171"
    try {
      for (const [index, address] of [
        ip,
        "::ffff:192.0.2.171",
        "::ffff:c000:2ab",
      ].entries())
        for (let i = 0; i < 10; i++)
          expect(await f.rpc(index, address)).toBe("not_found")
      expect(await f.rpc(3, ip)).toBe("limited")
      expect(await f.rpc(3, "192.0.2.172")).toBe("not_found")
      const [{ prefixes }] = await f.sql(
        "select array_agg(distinct client_prefix::text) as prefixes from public.pairing_redemption_failures where person_id = any($1::uuid[])",
        [f.users.slice(0, 3).map((u) => u.personId)],
      )
      expect(prefixes).toEqual([`${ip}/32`])
    } finally {
      await f.close()
    }
  },
)

for (const lock of ["code", "person", "redemption"] as const) {
  integrationTest(
    `fresh TTL and failure timestamp after waiting for ${lock}`,
    async () => {
      const f = await fixture()
      let held: Awaited<ReturnType<typeof holdDeviceLinkRows>> | undefined
      try {
        const { code } = await f
          .caller(0)
          .pairing.create({ purpose: "connection" })
        if (lock === "redemption") await f.rpc(1, f.ip, code)
        await f.sql(
          "update public.pairing_codes set created_at = clock_timestamp() where code = $1",
          [code],
        )
        held = await holdDeviceLinkRows(f.db, {
          hold: [
            [
              lock === "person" ?
                "select 1 from public.people where id = $1 for update"
              : `select 1 from public.${lock === "code" ? "pairing_codes" : "pairing_code_redemptions"} where code = $1 for update`,
              [lock === "person" ? f.users[1]!.personId : code],
            ],
          ],
        })
        const attempt = f.rpc(1, f.ip, code, 1)
        await held.waitForBlocked()
        await new Promise((resolve) => setTimeout(resolve, 1100))
        const [{ released_at }] = await f.sql(
          "select clock_timestamp() as released_at",
        )
        await held.release()
        expect(await attempt).toBe("not_found")
        const [{ created_at }] = await f.sql(
          "select created_at from public.pairing_redemption_failures where person_id = $1",
          [f.users[1]!.personId],
        )
        expect(new Date(created_at).getTime()).toBeGreaterThanOrEqual(
          new Date(released_at).getTime(),
        )
        expect(await f.count()).toBe(1)
      } finally {
        await held?.close()
        await f.close()
      }
    },
  )
}

for (const mutation of ["delete", "regenerate", "delete_person"] as const) {
  integrationTest(`redemption sees ${mutation} after lock wait`, async () => {
    const f = await fixture()
    let held: Awaited<ReturnType<typeof holdDeviceLinkRows>> | undefined
    try {
      const { code } = await f
        .caller(0)
        .pairing.create({ purpose: "connection" })
      const person = mutation === "delete_person"
      held = await holdDeviceLinkRows(f.db, {
        hold: [
          [
            person ?
              "select 1 from public.people where id = $1 for update"
            : "select 1 from public.pairing_codes where code = $1 for update",
            [person ? f.users[1]!.personId : code],
          ],
        ],
        finish: [
          [
            person ? "delete from public.people where id = $1"
            : mutation === "delete" ?
              "delete from public.pairing_codes where code = $1"
            : "update public.pairing_codes set code = 'NEW' || code where code = $1",
            [person ? f.users[1]!.personId : code],
          ],
        ],
      })
      const attempt = f.rpc(1, f.ip, code)
      await held.waitForBlocked()
      await held.release()
      expect(await attempt).toBe(person ? "person_missing" : "not_found")
      expect(await f.count()).toBe(person ? 0 : 1)
    } finally {
      await held?.close()
      await f.close()
    }
  })
}

integrationTest(
  "lock timeout rolls back without charging a failure",
  async () => {
    const f = await fixture()
    let held: Awaited<ReturnType<typeof holdDeviceLinkRows>> | undefined
    try {
      const { code } = await f
        .caller(0)
        .pairing.create({ purpose: "connection" })
      held = await holdDeviceLinkRows(f.db, {
        hold: [
          [
            "select 1 from public.pairing_codes where code = $1 for update",
            [code],
          ],
        ],
      })
      await expect(f.rpc(1, f.ip, code)).rejects.toMatchObject({
        code: "55P03",
      })
      expect(await f.count()).toBe(0)
    } finally {
      await held?.close()
      await f.close()
    }
  },
  10000,
)

integrationTest(
  "budget window uses the clock after advisory lock waits",
  async () => {
    const f = await fixture()
    let held: Awaited<ReturnType<typeof holdDeviceLinkRows>> | undefined
    try {
      for (let i = 0; i < 10; i++) await f.rpc(0)
      await f.sql(
        "update public.pairing_redemption_failures set created_at = clock_timestamp() - interval '899 seconds' where person_id = $1",
        [f.users[0]!.personId],
      )
      held = await holdDeviceLinkRows(f.db, {
        hold: [
          [
            "select pg_advisory_xact_lock(74101, hashtext($1))",
            [f.users[0]!.personId],
          ],
        ],
      })
      const attempt = f.rpc(0)
      await held.waitForBlocked()
      await new Promise((resolve) => setTimeout(resolve, 1100))
      await held.release()
      expect(await attempt).toBe("not_found")
      expect(await f.count()).toBe(11)
    } finally {
      await held?.close()
      await f.close()
    }
  },
)

integrationTest(
  "redemption storage and RPC are service-role only with bounded locks",
  async () => {
    const f = await fixture()
    try {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const [grants] = await f.sql(
          `select has_table_privilege($1, 'public.pairing_redemption_failures', 'select') as read, has_table_privilege($1, 'public.pairing_redemption_failures', 'insert') as write, has_function_privilege($1, 'public.redeem_pairing_code(uuid,inet,text,text,integer)', 'execute') as execute`,
          [role],
        )
        expect(grants).toEqual({
          read: role === "service_role",
          write: role === "service_role",
          execute: role === "service_role",
        })
      }
      const [fn] = await f.sql(
        "select prosecdef, proconfig from pg_proc where oid = 'public.redeem_pairing_code(uuid,inet,text,text,integer)'::regprocedure",
      )
      expect(fn.prosecdef).toBe(false)
      expect(fn.proconfig).toContain('search_path=""')
      expect(fn.proconfig).toContain("lock_timeout=3s")
      const [{ relrowsecurity, policies }] = await f.sql(
        "select relrowsecurity, (select count(*)::int from pg_policy where polrelid = c.oid) as policies from pg_class c where oid = 'public.pairing_redemption_failures'::regclass",
      )
      expect(relrowsecurity).toBe(true)
      expect(policies).toBe(0)
      const { error } = await f.admin.rpc("redeem_pairing_code", {
        redeemer_id: f.users[0]!.personId,
        client_ip: "192.0.2.1/24",
        pairing_code: "MISSING",
        pairing_purpose: "connection",
        ttl_seconds: 300,
      })
      expect(error?.code).toBe("22023")
      expect(await f.count()).toBe(0)
    } finally {
      await f.close()
    }
  },
)

integrationTest(
  "scheduled cleanup deletes only expired failures and its own old job logs",
  async () => {
    const f = await fixture()
    try {
      const jobs = await f.sql(
        "select jobid, schedule, command, active from cron.job where jobname = 'purge-pairing-redemption-failures'",
      )
      const [{ n: extensions }] = await f.sql(
        "select count(*)::int as n from pg_extension where extname = 'pg_cron'",
      )
      expect(extensions).toBe(1)
      expect(jobs).toHaveLength(1)
      const job = jobs[0]!
      expect(job.schedule).toBe("*/5 * * * *")
      expect(job.active).toBe(true)
      await f.rpc(0)
      await f.rpc(1)
      await f.sql(
        "update public.pairing_redemption_failures set created_at = now() - interval '16 minutes' where person_id = $1",
        [f.users[0]!.personId],
      )
      const marker = `cleanup-${crypto.randomUUID()}`
      const logs = await f.sql(
        "insert into cron.job_run_details (runid, jobid, database, username, command, status, start_time, end_time) values ($4, $1, 'postgres', 'postgres', $3, 'succeeded', now() - interval '2 days', now() - interval '2 days'), ($4::bigint - 1, $2, 'postgres', 'postgres', $3, 'succeeded', now() - interval '2 days', now() - interval '2 days'), ($4::bigint - 2, $1, 'postgres', 'postgres', $3, 'succeeded', now(), now()) returning runid",
        [job.jobid, -1, marker, -Date.now()],
      )
      try {
        await f.sql(job.command)
        expect(await f.count(0)).toBe(0)
        expect(await f.count(1)).toBe(1)
        const remaining = await f.sql(
          "select jobid from cron.job_run_details where command = $1 order by jobid",
          [marker],
        )
        expect(remaining).toEqual([{ jobid: "-1" }, { jobid: job.jobid }])
        const [{ n }] = await f.sql(
          "select count(*)::int as n from auth.users where id = any($1::uuid[])",
          [f.users.map((u) => u.authId)],
        )
        expect(n).toBe(6)
      } finally {
        await f.sql(
          "delete from cron.job_run_details where runid = any($1::bigint[])",
          [logs.map((row) => row.runid)],
        )
      }
    } finally {
      await f.close()
    }
  },
)
