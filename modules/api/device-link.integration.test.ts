import { createClient } from "@supabase/supabase-js"
import { expect, test } from "bun:test"
import { subMinutes } from "date-fns"

import { fixtureClientIp } from "@/modules/api/fixture-client-ip"
import { canonicalConnectionIds } from "@/modules/connections/create/connection-ids"
import type { Database } from "@/supabase/types"
import { createAdminClient } from "@/utils/supabase/admin"

import { holdDeviceLinkRows, queryDatabase } from "./device-link-locks"
import { appRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

const payload = {
  files: [{ name: "file.txt", size: 1, mimeType: "text/plain" }],
}

function createBrowserClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

class Fixture {
  readonly admin = createAdminClient()
  readonly databaseUrl: string
  readonly authIds: string[] = []

  constructor() {
    const databaseUrl = process.env.DB_URL
    if (
      !databaseUrl ||
      !URL.canParse(databaseUrl) ||
      !["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)
    )
      throw new Error("DB_URL must be a PostgreSQL URL when RUN_DB_TESTS=1")
    this.databaseUrl = databaseUrl
  }

  caller(authId: string | null) {
    return appRouter.createCaller({
      clientIp: fixtureClientIp(),
      userId: authId,
    })
  }

  async permanentUser(label: string) {
    const email = `device-link-${label}-${crypto.randomUUID()}@example.test`
    const password = crypto.randomUUID()
    const { data, error } = await this.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error || !data.user) throw error ?? new Error("User creation failed")
    this.authIds.push(data.user.id)
    return {
      authId: data.user.id,
      email,
      password,
      personId: await this.personId(data.user.id),
    }
  }

  async anonymousUser(label: string) {
    const user = await this.permanentUser(label)
    await this.setAnonymous(user.authId, true)
    return user
  }

  async setAnonymous(authId: string, anonymous: boolean) {
    await queryDatabase(
      this.databaseUrl,
      "update auth.users set is_anonymous = $1 where id = $2",
      [anonymous, authId],
    )
  }

  async personId(authId: string) {
    const { data, error } = await this.admin
      .from("people")
      .select("id")
      .eq("auth_user_id", authId)
      .single()
    if (error) throw error
    return data.id
  }

  async devices(personId: string, count: number, label: string) {
    const ids = Array.from({ length: count }, () => crypto.randomUUID())
    const { error } = await this.admin.from("devices").insert(
      ids.map((id, index) => ({
        id,
        person_id: personId,
        name: `${label} ${index}`,
      })),
    )
    if (error) throw error
    return ids
  }

  async connect(first: string, second: string) {
    const [person_1_id, person_2_id] = canonicalConnectionIds(first, second)
    const { error } = await this.admin
      .from("connections")
      .insert({ person_1_id, person_2_id })
    if (error) throw error
  }

  async prepareLink(
    target: { authId: string },
    label: string,
    deviceCount = 1,
  ) {
    const source = await this.anonymousUser(label)
    const deviceIds = await this.devices(source.personId, deviceCount, label)
    const { code } = await this.caller(target.authId).pairing.create({
      purpose: "device",
    })
    expect(await this.caller(source.authId).devices.link({ code })).toBe(
      undefined,
    )
    return { source, deviceIds, code }
  }

  async authUserExists(authId: string) {
    const rows = await queryDatabase(
      this.databaseUrl,
      "select count(*)::int as count from auth.users where id = $1",
      [authId],
    )
    return rows[0].count === 1
  }

  async sessionCount(authId: string) {
    const rows = await queryDatabase(
      this.databaseUrl,
      "select count(*)::int as count from auth.sessions where user_id = $1",
      [authId],
    )
    return rows[0].count as number
  }

  async personExists(personId: string) {
    const { data, error } = await this.admin
      .from("people")
      .select("id")
      .eq("id", personId)
      .maybeSingle()
    if (error) throw error
    return data !== null
  }

  async deviceOwner(deviceId: string) {
    const { data, error } = await this.admin
      .from("devices")
      .select("person_id")
      .eq("id", deviceId)
      .maybeSingle()
    if (error) throw error
    return data?.person_id ?? null
  }

  async codeRow(code: string) {
    const { data, error } = await this.admin
      .from("pairing_codes")
      .select("person_id, purpose, pairing_code_redemptions(from_person_id)")
      .eq("code", code)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async connectionsOf(personId: string) {
    const { data, error } = await this.admin
      .from("connections")
      .select("person_1_id, person_2_id")
      .or(`person_1_id.eq.${personId},person_2_id.eq.${personId}`)
    if (error) throw error
    return data
      .map(({ person_1_id, person_2_id }) =>
        person_1_id === personId ? person_2_id : person_1_id,
      )
      .sort()
  }

  async intentsOf(personId: string) {
    const { data, error } = await this.admin
      .from("share_request_intents")
      .select("request_id, cancelled_at")
      .eq("from_person_id", personId)
    if (error) throw error
    return new Map(data.map((row) => [row.request_id, row.cancelled_at]))
  }

  async request(requestId: string) {
    const { data, error } = await this.admin
      .from("share_requests")
      .select()
      .eq("id", requestId)
      .maybeSingle()
    if (error) throw error
    return data
  }

  async insertRequest(
    row: {
      id: string
      from_person_id: string
      from_device_id: string
      to_person_id: string
    } & Partial<{ created_at: string; expires_at: string }>,
  ) {
    const { error } = await this.admin.from("share_requests").insert({
      payload,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      ...row,
    })
    if (error) throw error
  }

  async expectUntouched(link: {
    source: { authId: string; personId: string }
    deviceIds: string[]
    code: string
  }) {
    expect(await this.authUserExists(link.source.authId)).toBe(true)
    expect(await this.personExists(link.source.personId)).toBe(true)
    for (const deviceId of link.deviceIds)
      expect(await this.deviceOwner(deviceId)).toBe(link.source.personId)
    expect(await this.codeRow(link.code)).toMatchObject({
      purpose: "device",
      pairing_code_redemptions: { from_person_id: link.source.personId },
    })
  }

  async expectMerged(
    target: { personId: string },
    link: {
      source: { authId: string; personId: string }
      deviceIds: string[]
      code: string
    },
  ) {
    expect(await this.authUserExists(link.source.authId)).toBe(false)
    expect(await this.personExists(link.source.personId)).toBe(false)
    for (const deviceId of link.deviceIds)
      expect(await this.deviceOwner(deviceId)).toBe(target.personId)
    expect(await this.codeRow(link.code)).toBeNull()
  }

  async cleanup() {
    await Promise.all(
      this.authIds.map((authId) => this.admin.auth.admin.deleteUser(authId)),
    )
  }
}

integrationTest(
  "complete_device_link is a service-role-only security definer",
  async () => {
    const fixture = new Fixture()
    const browser = createBrowserClient()
    const signature =
      "public.complete_device_link(uuid, text, uuid, timestamptz)"
    try {
      const [grants] = await queryDatabase(
        fixture.databaseUrl,
        `select
          has_function_privilege('anon', '${signature}', 'execute') as anon,
          has_function_privilege('authenticated', '${signature}', 'execute') as authenticated,
          has_function_privilege('service_role', '${signature}', 'execute') as service_role,
          prosecdef as security_definer,
          pg_get_userbyid(proowner) as owner,
          proconfig as config
        from pg_proc
        where oid = '${signature}'::regprocedure`,
      )
      expect(grants).toMatchObject({
        anon: false,
        authenticated: false,
        service_role: true,
        security_definer: true,
        owner: "postgres",
      })
      expect(grants.config).toContain("lock_timeout=3s")
      expect(
        grants.config.some((setting: string) =>
          setting.startsWith("search_path="),
        ),
      ).toBe(true)

      const user = await fixture.permanentUser("grants")
      const rpcInput = {
        target_auth_user_id: user.authId,
        link_code: "ABCDEFGH",
        source_device_id: crypto.randomUUID(),
        min_created_at: new Date().toISOString(),
      }
      expect(
        (await browser.rpc("complete_device_link", rpcInput)).error,
      ).toMatchObject({ code: "42501" })
      const { error: loginError } = await browser.auth.signInWithPassword(user)
      if (loginError) throw loginError
      expect(
        (await browser.rpc("complete_device_link", rpcInput)).error,
      ).toMatchObject({ code: "42501" })
    } finally {
      await browser.auth.signOut()
      await fixture.cleanup()
    }
  },
)

integrationTest(
  "device pairing codes are restricted to permanent owners and anonymous first redeemers",
  async () => {
    const fixture = new Fixture()
    try {
      const target = await fixture.permanentUser("target")
      const source = await fixture.anonymousUser("source")
      const rival = await fixture.anonymousUser("rival")
      const [sourceDevice] = await fixture.devices(source.personId, 1, "source")
      const owner = fixture.caller(target.authId)
      const phone = fixture.caller(source.authId)
      const other = fixture.caller(rival.authId)
      const unauthenticated = fixture.caller(null)
      const withoutPerson = fixture.caller(crypto.randomUUID())

      await expect(
        unauthenticated.pairing.create({ purpose: "device" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      await expect(
        unauthenticated.devices.link({ code: "ABCDEFGH" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      await expect(
        unauthenticated.devices.completeLink({
          code: "ABCDEFGH",
          deviceId: sourceDevice!,
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      await expect(
        withoutPerson.devices.link({ code: "ABCDEFGH" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        withoutPerson.devices.completeLink({
          code: "ABCDEFGH",
          deviceId: sourceDevice!,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })

      await expect(
        phone.pairing.create({ purpose: "device" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      const anonymousConnection = await phone.pairing.create({
        purpose: "connection",
      })
      expect(await fixture.codeRow(anonymousConnection.code)).toMatchObject({
        person_id: source.personId,
        purpose: "connection",
      })

      const firstDevice = await owner.pairing.create({ purpose: "device" })
      const connection = await owner.pairing.create({ purpose: "connection" })
      const secondDevice = await owner.pairing.create({ purpose: "device" })
      expect(await fixture.codeRow(firstDevice.code)).toBeNull()
      expect(await fixture.codeRow(connection.code)).toMatchObject({
        person_id: target.personId,
        purpose: "connection",
      })
      expect(await fixture.codeRow(secondDevice.code)).toMatchObject({
        person_id: target.personId,
        purpose: "device",
        pairing_code_redemptions: null,
      })

      await expect(
        owner.devices.link({ code: secondDevice.code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        phone.devices.link({ code: connection.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(phone.devices.link({ code: "NOPE" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
      await expect(
        other.pairing.redeem({ code: secondDevice.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      const { error: expireError } = await fixture.admin
        .from("pairing_codes")
        .update({ created_at: subMinutes(new Date(), 5.1).toISOString() })
        .eq("code", secondDevice.code)
      if (expireError) throw expireError
      await expect(
        phone.devices.link({ code: secondDevice.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      const { error: reviveError } = await fixture.admin
        .from("pairing_codes")
        .update({ created_at: subMinutes(new Date(), 4.9).toISOString() })
        .eq("code", secondDevice.code)
      if (reviveError) throw reviveError

      expect(
        await phone.devices.link({
          code: ` ${secondDevice.code.toLowerCase()} `,
        }),
      ).toBe(undefined)
      await expect(
        other.devices.link({ code: secondDevice.code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect(await phone.devices.link({ code: secondDevice.code })).toBe(
        undefined,
      )
      expect(await fixture.codeRow(secondDevice.code)).toMatchObject({
        pairing_code_redemptions: { from_person_id: source.personId },
      })

      const contested = await owner.pairing.create({ purpose: "device" })
      const attempts = await Promise.allSettled([
        phone.devices.link({ code: contested.code }),
        other.devices.link({ code: contested.code }),
      ])
      expect(
        attempts.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1)
      const loser = attempts.find(({ status }) => status === "rejected")
      expect(loser?.status === "rejected" && loser.reason.code).toBe(
        "FORBIDDEN",
      )
      const winnerIndex = attempts.findIndex(
        ({ status }) => status === "fulfilled",
      )
      expect(await fixture.codeRow(contested.code)).toMatchObject({
        pairing_code_redemptions: {
          from_person_id: [source.personId, rival.personId][winnerIndex],
        },
      })

      const { error: staleError } = await fixture.admin
        .from("pairing_codes")
        .update({ created_at: subMinutes(new Date(), 5.1).toISOString() })
        .eq("code", contested.code)
      if (staleError) throw staleError
      await expect(
        owner.devices.completeLink({
          code: contested.code,
          deviceId: sourceDevice!,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      expect(await fixture.authUserExists(source.authId)).toBe(true)
      expect(await fixture.authUserExists(rival.authId)).toBe(true)
      expect(await fixture.deviceOwner(sourceDevice!)).toBe(source.personId)
    } finally {
      await fixture.cleanup()
    }
  },
)

integrationTest(
  "completing a link merges the anonymous person into the permanent account",
  async () => {
    const fixture = new Fixture()
    const phoneBrowser = createBrowserClient()
    let anonymousAuthId: string | undefined
    try {
      const target = await fixture.permanentUser("target")
      const friend = await fixture.permanentUser("friend")
      const stranger = await fixture.permanentUser("stranger")
      const { data: anonymous, error: anonymousError } =
        await phoneBrowser.auth.signInAnonymously()
      if (anonymousError || !anonymous.user)
        throw anonymousError ?? new Error("Anonymous sign-in failed")
      anonymousAuthId = anonymous.user.id
      const source = {
        authId: anonymous.user.id,
        personId: await fixture.personId(anonymous.user.id),
      }
      expect(await fixture.sessionCount(source.authId)).toBe(1)

      const [phone, tablet] = await fixture.devices(source.personId, 2, "phone")
      const [computer] = await fixture.devices(target.personId, 1, "computer")
      const [friendDevice] = await fixture.devices(friend.personId, 1, "friend")
      await fixture.connect(source.personId, friend.personId)
      await fixture.connect(source.personId, stranger.personId)
      await fixture.connect(source.personId, target.personId)
      await fixture.connect(target.personId, friend.personId)

      const owner = fixture.caller(target.authId)
      const anonymousCaller = fixture.caller(source.authId)
      const ids = {
        pending: crypto.randomUUID(),
        cancelled: crypto.randomUUID(),
        expired: crypto.randomUUID(),
        accepted: crypto.randomUUID(),
        fromFriend: crypto.randomUUID(),
        fromTarget: crypto.randomUUID(),
        selfShare: crypto.randomUUID(),
        intentOnly: crypto.randomUUID(),
      }
      for (const id of [ids.pending, ids.cancelled, ids.accepted])
        await fixture.insertRequest({
          id,
          from_person_id: source.personId,
          from_device_id: phone!,
          to_person_id: friend.personId,
        })
      await fixture.insertRequest({
        id: ids.expired,
        from_person_id: source.personId,
        from_device_id: phone!,
        to_person_id: friend.personId,
        created_at: subMinutes(new Date(), 20).toISOString(),
        expires_at: subMinutes(new Date(), 10).toISOString(),
      })
      await fixture.insertRequest({
        id: ids.fromFriend,
        from_person_id: friend.personId,
        from_device_id: friendDevice!,
        to_person_id: source.personId,
      })
      await fixture.insertRequest({
        id: ids.fromTarget,
        from_person_id: target.personId,
        from_device_id: computer!,
        to_person_id: source.personId,
      })
      await fixture.insertRequest({
        id: ids.selfShare,
        from_person_id: source.personId,
        from_device_id: tablet!,
        to_person_id: source.personId,
      })
      const { error: responseError } = await fixture.admin
        .from("share_request_responses")
        .insert({
          request_id: ids.accepted,
          accepted: true,
          accepted_by_device_id: friendDevice!,
        })
      if (responseError) throw responseError
      const cancelled = await anonymousCaller.shares.cancel({
        requestId: ids.cancelled,
      })
      const intentOnly = await anonymousCaller.shares.cancel({
        requestId: ids.intentOnly,
      })
      const anonymousConnectionCode = await anonymousCaller.pairing.create({
        purpose: "connection",
      })

      const { code } = await owner.pairing.create({ purpose: "device" })
      expect(await anonymousCaller.devices.link({ code })).toBe(undefined)

      const { data: swapped, error: swapError } =
        await phoneBrowser.auth.signInWithPassword(target)
      if (swapError || !swapped.session)
        throw swapError ?? new Error("Sign-in failed")
      const { data: claims, error: claimsError } =
        await phoneBrowser.auth.getClaims()
      if (claimsError || !claims) throw claimsError ?? new Error("No claims")
      expect(claims.claims.sub).toBe(target.authId)
      const linked = fixture.caller(claims.claims.sub)

      expect(
        await linked.devices.completeLink({ code, deviceId: phone! }),
      ).toBe(undefined)

      await fixture.expectMerged(target, {
        source,
        deviceIds: [phone!, tablet!],
        code,
      })
      expect(await fixture.sessionCount(source.authId)).toBe(0)
      const { error: lookupError } = await fixture.admin.auth.admin.getUserById(
        source.authId,
      )
      expect(lookupError?.status).toBe(404)
      expect(await fixture.deviceOwner(computer!)).toBe(target.personId)
      expect(await fixture.codeRow(anonymousConnectionCode.code)).toBeNull()

      expect(await fixture.connectionsOf(target.personId)).toEqual(
        [friend.personId, stranger.personId].sort(),
      )
      expect(await fixture.connectionsOf(source.personId)).toEqual([])

      const { data: requests, error: requestsError } = await fixture.admin
        .from("share_requests")
        .select(
          "id, from_person_id, from_device_id, to_person_id, cancelled_at, share_request_responses(accepted, accepted_by_device_id)",
        )
        .in("id", Object.values(ids))
      if (requestsError) throw requestsError
      const byId = new Map(requests.map((request) => [request.id, request]))
      expect(byId.size).toBe(7)
      for (const id of [ids.pending, ids.cancelled, ids.expired, ids.accepted])
        expect(byId.get(id)).toMatchObject({
          from_person_id: target.personId,
          from_device_id: phone!,
          to_person_id: friend.personId,
        })
      expect(byId.get(ids.cancelled)?.cancelled_at).toBe(cancelled.cancelled_at)
      expect(byId.get(ids.pending)?.cancelled_at).toBeNull()
      expect(byId.get(ids.accepted)?.share_request_responses).toEqual({
        accepted: true,
        accepted_by_device_id: friendDevice!,
      })
      expect(byId.get(ids.fromFriend)).toMatchObject({
        from_person_id: friend.personId,
        to_person_id: target.personId,
      })
      expect(byId.get(ids.fromTarget)).toMatchObject({
        from_person_id: target.personId,
        to_person_id: target.personId,
      })
      expect(byId.get(ids.selfShare)).toMatchObject({
        from_person_id: target.personId,
        from_device_id: tablet!,
        to_person_id: target.personId,
      })

      const intents = await fixture.intentsOf(target.personId)
      expect([...intents.keys()].sort()).toEqual(
        [
          ids.pending,
          ids.cancelled,
          ids.expired,
          ids.accepted,
          ids.selfShare,
          ids.intentOnly,
          ids.fromTarget,
        ].sort(),
      )
      expect(intents.get(ids.cancelled)).toBe(cancelled.cancelled_at)
      expect(intents.get(ids.intentOnly)).toBe(intentOnly.cancelled_at)
      expect(intents.get(ids.pending)).toBeNull()
      expect((await fixture.intentsOf(source.personId)).size).toBe(0)

      const retry = (
        requestId: string,
        toPersonId = friend.personId,
        deviceId = phone!,
      ) => linked.shares.request({ requestId, deviceId, toPersonId, payload })
      expect((await retry(ids.pending)).id).toBe(ids.pending)
      expect((await retry(ids.accepted)).id).toBe(ids.accepted)
      expect((await retry(ids.selfShare, target.personId, tablet!)).id).toBe(
        ids.selfShare,
      )
      await expect(retry(ids.cancelled)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Share request cancelled",
      })
      await expect(retry(ids.expired)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Share request expired",
      })
      await expect(retry(ids.intentOnly)).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Share request cancelled",
      })
      expect(await fixture.request(ids.intentOnly)).toBeNull()
      expect(await linked.shares.cancel({ requestId: ids.cancelled })).toEqual(
        cancelled,
      )

      await expect(
        linked.devices.completeLink({ code, deviceId: phone! }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(
        anonymousCaller.devices.link({ code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    } finally {
      await phoneBrowser.auth.signOut()
      if (anonymousAuthId)
        await fixture.admin.auth.admin.deleteUser(anonymousAuthId)
      await fixture.cleanup()
    }
  },
  30_000,
)

integrationTest(
  "completion refuses stale redemptions, foreign devices, and non-permanent targets",
  async () => {
    const fixture = new Fixture()
    try {
      const target = await fixture.permanentUser("target")
      const owner = fixture.caller(target.authId)

      const upgraded = await fixture.prepareLink(target, "upgraded")
      await fixture.setAnonymous(upgraded.source.authId, false)
      await expect(
        owner.devices.completeLink({
          code: upgraded.code,
          deviceId: upgraded.deviceIds[0]!,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
      await fixture.expectUntouched(upgraded)
      const { error: replaceError } = await fixture.admin
        .from("pairing_codes")
        .delete()
        .eq("code", upgraded.code)
      if (replaceError) throw replaceError

      const hijacked = await fixture.prepareLink(target, "attacker")
      const victim = await fixture.anonymousUser("victim")
      const [victimDevice] = await fixture.devices(victim.personId, 1, "victim")
      await expect(
        fixture.caller(victim.authId).devices.link({ code: hijacked.code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      for (const deviceId of [victimDevice!, crypto.randomUUID()]) {
        await expect(
          owner.devices.completeLink({ code: hijacked.code, deviceId }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" })
      }
      await fixture.expectUntouched(hijacked)
      expect(await fixture.deviceOwner(victimDevice!)).toBe(victim.personId)
      expect(await fixture.authUserExists(victim.authId)).toBe(true)

      await expect(
        fixture.caller(target.personId).devices.completeLink({
          code: hijacked.code,
          deviceId: hijacked.deviceIds[0]!,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        fixture.caller(hijacked.source.authId).devices.completeLink({
          code: hijacked.code,
          deviceId: hijacked.deviceIds[0]!,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await fixture.expectUntouched(hijacked)

      await fixture.setAnonymous(target.authId, true)
      await expect(
        owner.devices.completeLink({
          code: hijacked.code,
          deviceId: hijacked.deviceIds[0]!,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await fixture.expectUntouched(hijacked)
      await fixture.setAnonymous(target.authId, false)

      const attempts = await Promise.allSettled([
        owner.devices.completeLink({
          code: hijacked.code,
          deviceId: hijacked.deviceIds[0]!,
        }),
        owner.devices.completeLink({
          code: hijacked.code,
          deviceId: hijacked.deviceIds[0]!,
        }),
      ])
      expect(
        attempts.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1)
      const rejected = attempts.find(({ status }) => status === "rejected")
      expect(rejected?.status === "rejected" && rejected.reason.code).toBe(
        "NOT_FOUND",
      )
      await fixture.expectMerged(target, hijacked)
      await expect(
        owner.devices.completeLink({
          code: hijacked.code,
          deviceId: hijacked.deviceIds[0]!,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
    } finally {
      await fixture.cleanup()
    }
  },
)

integrationTest(
  "completion waits for in-flight writes to the anonymous person and moves them",
  async () => {
    const fixture = new Fixture()
    try {
      const target = await fixture.permanentUser("target")
      const friend = await fixture.permanentUser("friend")
      const owner = fixture.caller(target.authId)

      const deviceLink = await fixture.prepareLink(target, "device-writer")
      const lateDevice = crypto.randomUUID()
      const deviceHolder = await holdDeviceLinkRows(fixture.databaseUrl, {
        hold: [
          [
            "insert into public.devices (id, person_id, name) values ($1, $2, 'Late')",
            [lateDevice, deviceLink.source.personId],
          ],
        ],
      })
      try {
        const completion = owner.devices.completeLink({
          code: deviceLink.code,
          deviceId: deviceLink.deviceIds[0]!,
        })
        const settled = Promise.allSettled([completion])
        await deviceHolder.waitForBlocked()
        await fixture.expectUntouched(deviceLink)
        await deviceHolder.release()
        await settled
        expect(await completion).toBe(undefined)
      } finally {
        await deviceHolder.close()
      }
      await fixture.expectMerged(target, deviceLink)
      expect(await fixture.deviceOwner(lateDevice)).toBe(target.personId)

      const requestLink = await fixture.prepareLink(target, "request-writer")
      await fixture.connect(requestLink.source.personId, friend.personId)
      const lateRequest = crypto.randomUUID()
      const requestHolder = await holdDeviceLinkRows(fixture.databaseUrl, {
        hold: [
          [
            `insert into public.share_requests (id, from_person_id, from_device_id, to_person_id, payload, expires_at)
             values ($1, $2, $3, $4, $5::jsonb, now() + interval '10 minutes')`,
            [
              lateRequest,
              requestLink.source.personId,
              requestLink.deviceIds[0]!,
              friend.personId,
              JSON.stringify(payload),
            ],
          ],
        ],
      })
      try {
        const completion = owner.devices.completeLink({
          code: requestLink.code,
          deviceId: requestLink.deviceIds[0]!,
        })
        const settled = Promise.allSettled([completion])
        await requestHolder.waitForBlocked()
        await requestHolder.release()
        await settled
        expect(await completion).toBe(undefined)
      } finally {
        await requestHolder.close()
      }
      await fixture.expectMerged(target, requestLink)
      expect(await fixture.request(lateRequest)).toMatchObject({
        from_person_id: target.personId,
        from_device_id: requestLink.deviceIds[0]!,
        to_person_id: friend.personId,
      })
      expect((await fixture.intentsOf(target.personId)).has(lateRequest)).toBe(
        true,
      )
      expect(await fixture.connectionsOf(target.personId)).toEqual([
        friend.personId,
      ])
    } finally {
      await fixture.cleanup()
    }
  },
)

integrationTest(
  "completion never waits while holding the anonymous person and recovers orphan intents",
  async () => {
    const fixture = new Fixture()
    try {
      const target = await fixture.permanentUser("target")
      const friend = await fixture.permanentUser("friend")
      const owner = fixture.caller(target.authId)

      const orphanLink = await fixture.prepareLink(target, "orphan")
      await fixture.connect(orphanLink.source.personId, friend.personId)
      const orphanRequest = crypto.randomUUID()
      await fixture.insertRequest({
        id: orphanRequest,
        from_person_id: orphanLink.source.personId,
        from_device_id: orphanLink.deviceIds[0]!,
        to_person_id: friend.personId,
      })
      const { error: orphanError } = await fixture.admin
        .from("share_requests")
        .delete()
        .eq("id", orphanRequest)
      if (orphanError) throw orphanError
      const insertOrphan = [
        `insert into public.share_requests (id, from_person_id, from_device_id, to_person_id, payload, expires_at)
         values ($1, $2, $3, $4, $5::jsonb, now() + interval '10 minutes')`,
        [
          orphanRequest,
          orphanLink.source.personId,
          orphanLink.deviceIds[0]!,
          friend.personId,
          JSON.stringify(payload),
        ],
      ] as const
      const lockIntent = [
        "select 1 from public.share_request_intents where from_person_id = $1 and request_id = $2 for update",
        [orphanLink.source.personId, orphanRequest],
      ] as const

      const intentHolder = await holdDeviceLinkRows(fixture.databaseUrl, {
        hold: [lockIntent],
        finish: [insertOrphan],
      })
      try {
        const started = Date.now()
        await expect(
          owner.devices.completeLink({
            code: orphanLink.code,
            deviceId: orphanLink.deviceIds[0]!,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" })
        expect(Date.now() - started).toBeLessThan(2_500)
        await fixture.expectUntouched(orphanLink)
        expect(
          (await fixture.intentsOf(orphanLink.source.personId)).has(
            orphanRequest,
          ),
        ).toBe(true)
      } finally {
        await intentHolder.release()
        await intentHolder.close()
      }
      expect(
        await owner.devices.completeLink({
          code: orphanLink.code,
          deviceId: orphanLink.deviceIds[0]!,
        }),
      ).toBe(undefined)
      await fixture.expectMerged(target, orphanLink)
      expect(await fixture.request(orphanRequest)).toMatchObject({
        from_person_id: target.personId,
        to_person_id: friend.personId,
      })
      expect(
        (await fixture.intentsOf(target.personId)).has(orphanRequest),
      ).toBe(true)

      const cycleLink = await fixture.prepareLink(target, "cycle")
      await fixture.connect(cycleLink.source.personId, friend.personId)
      const cycleRequest = crypto.randomUUID()
      await fixture.insertRequest({
        id: cycleRequest,
        from_person_id: cycleLink.source.personId,
        from_device_id: cycleLink.deviceIds[0]!,
        to_person_id: friend.personId,
      })
      const { error: cycleError } = await fixture.admin
        .from("share_requests")
        .delete()
        .eq("id", cycleRequest)
      if (cycleError) throw cycleError
      const personHolder = await holdDeviceLinkRows(fixture.databaseUrl, {
        hold: [
          [
            "select 1 from public.people where id = $1 for update",
            [cycleLink.source.personId],
          ],
        ],
      })
      const writer = await holdDeviceLinkRows(fixture.databaseUrl, {
        hold: [
          [
            "select 1 from public.share_request_intents where from_person_id = $1 and request_id = $2 for update",
            [cycleLink.source.personId, cycleRequest],
          ],
        ],
        finish: [
          [
            `insert into public.share_requests (id, from_person_id, from_device_id, to_person_id, payload, expires_at)
             values ($1, $2, $3, $4, $5::jsonb, now() + interval '10 minutes')`,
            [
              cycleRequest,
              cycleLink.source.personId,
              cycleLink.deviceIds[0]!,
              friend.personId,
              JSON.stringify(payload),
            ],
          ],
        ],
      })
      try {
        const completion = owner.devices.completeLink({
          code: cycleLink.code,
          deviceId: cycleLink.deviceIds[0]!,
        })
        const settled = Promise.allSettled([completion])
        await personHolder.waitForBlocked(1)
        const writerDone = writer.release()
        await writer.waitUntilBlocked()
        await personHolder.release()
        await writerDone
        await settled
        const outcome = await completion.then(
          () => "fulfilled",
          (error) => error.code,
        )
        expect(["fulfilled", "CONFLICT"]).toContain(outcome)
        if (outcome === "CONFLICT")
          expect(
            await owner.devices.completeLink({
              code: cycleLink.code,
              deviceId: cycleLink.deviceIds[0]!,
            }),
          ).toBe(undefined)
      } finally {
        await personHolder.close()
        await writer.close()
      }
      await fixture.expectMerged(target, cycleLink)
      expect(await fixture.request(cycleRequest)).toMatchObject({
        from_person_id: target.personId,
        to_person_id: friend.personId,
      })
      expect((await fixture.intentsOf(target.personId)).has(cycleRequest)).toBe(
        true,
      )

      const deviceLink = await fixture.prepareLink(target, "device-lock")
      const deviceHolder = await holdDeviceLinkRows(fixture.databaseUrl, {
        hold: [
          [
            "delete from public.devices where id = $1",
            [deviceLink.deviceIds[0]!],
          ],
        ],
        outcome: "rollback",
      })
      try {
        const started = Date.now()
        await expect(
          owner.devices.completeLink({
            code: deviceLink.code,
            deviceId: deviceLink.deviceIds[0]!,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" })
        expect(Date.now() - started).toBeLessThan(2_500)
      } finally {
        await deviceHolder.release()
        await deviceHolder.close()
      }
      await fixture.expectUntouched(deviceLink)
      expect(
        await owner.devices.completeLink({
          code: deviceLink.code,
          deviceId: deviceLink.deviceIds[0]!,
        }),
      ).toBe(undefined)
      await fixture.expectMerged(target, deviceLink)
    } finally {
      await fixture.cleanup()
    }
  },
  30_000,
)

integrationTest(
  "connected anonymous people can link into different accounts concurrently",
  async () => {
    const fixture = new Fixture()
    try {
      const [firstTarget, secondTarget] = await Promise.all([
        fixture.permanentUser("first-target"),
        fixture.permanentUser("second-target"),
      ])
      const first = await fixture.prepareLink(firstTarget, "first-source")
      const second = await fixture.prepareLink(secondTarget, "second-source")
      await fixture.connect(first.source.personId, second.source.personId)

      const complete = (
        target: { authId: string },
        link: { code: string; deviceIds: string[] },
      ) =>
        fixture.caller(target.authId).devices.completeLink({
          code: link.code,
          deviceId: link.deviceIds[0]!,
        })
      const attempts = await Promise.allSettled([
        complete(firstTarget, first),
        complete(secondTarget, second),
      ])
      for (const [index, attempt] of attempts.entries()) {
        if (attempt.status === "fulfilled") continue
        expect(attempt.reason.code).toBe("CONFLICT")
        expect(
          await complete(
            index === 0 ? firstTarget : secondTarget,
            index === 0 ? first : second,
          ),
        ).toBe(undefined)
      }

      await fixture.expectMerged(firstTarget, first)
      await fixture.expectMerged(secondTarget, second)
      expect(await fixture.connectionsOf(firstTarget.personId)).toEqual([
        secondTarget.personId,
      ])
      expect(await fixture.connectionsOf(secondTarget.personId)).toEqual([
        firstTarget.personId,
      ])
    } finally {
      await fixture.cleanup()
    }
  },
)
