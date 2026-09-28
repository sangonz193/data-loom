import { createBrowserClient } from "@supabase/ssr"
import { expect, test } from "bun:test"
import { NextRequest } from "next/server"

import { POST } from "@/app/api/trpc/[trpc]/route"
import { createContext } from "@/modules/api/context"
import { queryDatabase } from "@/modules/api/device-link-locks"
import { fixtureClientIp } from "@/modules/api/fixture-client-ip"
import { appRouter } from "@/modules/api/router"
import { registerDevice } from "@/modules/connections/register-device"
import type { Database } from "@/supabase/types"
import { createAdminClient } from "@/utils/supabase/admin"
import { updateSession } from "@/utils/supabase/middleware"

import { completeDeviceLink } from "./device-link/complete-device-link"
import { createIsolatedAuth } from "./device-link/isolated-auth"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

async function fixture() {
  const admin = createAdminClient()
  const ids = [] as string[]
  async function permanent() {
    const credentials = {
      email: `setup-${crypto.randomUUID()}@example.test`,
      password: crypto.randomUUID(),
    }
    const { data, error } = await admin.auth.admin.createUser({
      ...credentials,
      email_confirm: true,
    })
    if (error) throw error
    ids.push(data.user.id)
    return { ...credentials, id: data.user.id }
  }
  const a = await permanent()
  const c = await permanent()
  const jar = new Map<string, string>()
  const browser = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      isSingleton: false,
      auth: { autoRefreshToken: false, detectSessionInUrl: false },
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          for (const cookie of cookies) jar.set(cookie.name, cookie.value)
        },
      },
    },
  )
  const anonymous = await browser.auth.signInAnonymously()
  if (anonymous.error) throw anonymous.error
  const b = anonymous.data.user!
  ids.push(b.id)
  const caller = appRouter.createCaller({
    clientIp: fixtureClientIp(),
    userId: b.id,
  })
  const deviceId = crypto.randomUUID()
  const storage = new Map([["data-loom-device-id", deviceId]])
  const deviceStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
  }
  const device = await registerDevice(
    b.id,
    (id) => caller.devices.register({ id, name: "Browser" }),
    deviceStorage,
  )
  const { code } = await appRouter
    .createCaller({ clientIp: fixtureClientIp(), userId: a.id })
    .pairing.create({ purpose: "device" })
  await caller.devices.link({ code })
  const isolated = createIsolatedAuth({
    apiUrl: "http://localhost/api/trpc",
    fetcher: (async (input, init) => {
      if (!String(input).startsWith("http://localhost/api/trpc"))
        return fetch(input, init)
      expect(init?.credentials).toBe("omit")
      const request = new NextRequest(String(input), {
        ...init,
        signal: init?.signal ?? undefined,
      })
      expect(request.headers.has("cookie")).toBe(false)
      const proxy = await updateSession(request)
      expect(proxy.headers.has("set-cookie")).toBe(false)
      const context = await createContext(request)
      expect([a.id, c.id]).toContain(context.userId!)
      return POST(request)
    }) as typeof fetch,
  })
  const cookieBefore = [...jar]
  const deps = {
    expectedUserId: b.id,
    readUser: async () => {
      const result = await browser.auth.getUser()
      if (result.error) throw result.error
      return result.data.user
    },
    signIn: async () => {
      const result = await isolated.client.auth.signInWithPassword(a)
      if (result.error) throw result.error
    },
    complete: () =>
      isolated.api.devices.completeLink.mutate({ code, deviceId }),
    ownsDevice: async () => {
      const result = await isolated.client
        .from("devices")
        .select("id")
        .eq("id", deviceId)
        .maybeSingle()
      if (result.error) throw result.error
      return !!result.data
    },
    signOut: async () => {
      const result = await isolated.client.auth.signOut({ scope: "local" })
      if (result.error) throw result.error
    },
    installSession: async () => {
      const result = await browser.auth.setSession(await isolated.session())
      if (result.error) throw result.error
      return result.data.session!
    },
    navigate: async () => {},
    progress: () => {},
  }
  async function intact() {
    expect((await browser.auth.getUser()).data.user?.id).toBe(b.id)
    expect([...jar]).toEqual(cookieBefore)
    expect(
      (
        await admin
          .from("devices")
          .select("person_id")
          .eq("id", deviceId)
          .single()
      ).data?.person_id,
    ).toBe(device.personId)
    expect(
      (
        await admin
          .from("people")
          .select("auth_user_id")
          .eq("id", device.personId)
          .single()
      ).data?.auth_user_id,
    ).toBe(b.id)
    expect(
      (
        await admin
          .from("pairing_code_redemptions")
          .select("from_person_id")
          .eq("code", code)
          .single()
      ).data?.from_person_id,
    ).toBe(device.personId)
    expect(
      (
        await queryDatabase(
          process.env.DB_URL!,
          "select count(*)::int as count from auth.sessions where user_id = $1",
          [b.id],
        )
      )[0].count,
    ).toBe(1)
  }
  return {
    admin,
    a,
    b,
    c,
    browser,
    isolated,
    deps,
    deviceId,
    deviceStorage,
    cookieBefore,
    jar,
    intact,
    async close() {
      browser.auth.dispose()
      isolated.client.auth.dispose()
      for (const id of ids) {
        const { error } = await admin.auth.admin.deleteUser(id)
        if (error && error.code !== "user_not_found") throw error
      }
    },
  }
}

integrationTest(
  "isolated Bearer completion leaves cookies unchanged until installing A and preserves the device id",
  async () => {
    const f = await fixture()
    try {
      let beforeInstall = false
      await completeDeviceLink({
        ...f.deps,
        installSession: async () => {
          expect([...f.jar]).toEqual(f.cookieBefore)
          const dead = await f.browser.auth.getUser()
          expect(dead.error?.code).toBe("user_not_found")
          expect(
            (await f.browser.auth.getSession()).data.session?.user.id,
          ).toBe(f.b.id)
          expect(await f.deps.ownsDevice()).toBe(true)
          beforeInstall = true
          return f.deps.installSession()
        },
      })
      expect(beforeInstall).toBe(true)
      expect((await f.browser.auth.getUser()).data.user?.id).toBe(f.a.id)
      const device = await registerDevice(
        f.a.id,
        (id) =>
          appRouter
            .createCaller({ clientIp: fixtureClientIp(), userId: f.a.id })
            .devices.register({ id, name: "Browser" }),
        f.deviceStorage,
      )
      expect(device.id).toBe(f.deviceId)
      expect(f.deviceStorage.getItem("data-loom-device-id")).toBe(f.deviceId)
    } finally {
      await f.close()
    }
  },
  30_000,
)

integrationTest(
  "wrong account leaves B, its redemption and cookies intact and revokes only C's isolated session",
  async () => {
    const f = await fixture()
    try {
      await expect(
        completeDeviceLink({
          ...f.deps,
          signIn: async () => {
            const { error } = await f.isolated.client.auth.signInWithPassword(
              f.c,
            )
            if (error) throw error
          },
        }),
      ).rejects.toThrow("belongs to a different account")
      await f.intact()
      expect(
        (
          await queryDatabase(
            process.env.DB_URL!,
            "select count(*)::int as count from auth.sessions where user_id = $1",
            [f.c.id],
          )
        )[0].count,
      ).toBe(0)
    } finally {
      await f.close()
    }
  },
  30_000,
)

integrationTest(
  "lost acknowledgement is confirmed by ownership and explicit Account sign-in recovers after tab death",
  async () => {
    const f = await fixture()
    try {
      await f.deps.signIn()
      expect(await f.deps.ownsDevice()).toBe(false)
      await f.deps.complete()
      await expect(f.deps.complete()).rejects.toMatchObject({
        data: { code: "NOT_FOUND" },
      })
      expect(await f.deps.ownsDevice()).toBe(true)
      expect([...f.jar]).toEqual(f.cookieBefore)
      expect((await f.browser.auth.getUser()).error?.code).toBe(
        "user_not_found",
      )
      expect((await f.browser.auth.getSession()).data.session?.user.id).toBe(
        f.b.id,
      )
      const recovered = await f.browser.auth.signInWithPassword(f.a)
      expect(recovered.error).toBeNull()
      expect(recovered.data.user?.id).toBe(f.a.id)
      const device = await registerDevice(
        f.a.id,
        (id) =>
          appRouter
            .createCaller({ clientIp: fixtureClientIp(), userId: f.a.id })
            .devices.register({ id, name: "Browser" }),
        f.deviceStorage,
      )
      expect(device.id).toBe(f.deviceId)
    } finally {
      await f.close()
    }
  },
  30_000,
)

integrationTest(
  "wrong password never completes the link or changes B's credentials",
  async () => {
    const f = await fixture()
    try {
      await expect(
        completeDeviceLink({
          ...f.deps,
          signIn: async () => {
            const { error } = await f.isolated.client.auth.signInWithPassword({
              email: f.a.email,
              password: "wrong-password",
            })
            if (error) throw error
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_credentials" })
      await f.intact()
    } finally {
      await f.close()
    }
  },
  30_000,
)
