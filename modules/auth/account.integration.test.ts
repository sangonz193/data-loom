import { createClient } from "@supabase/supabase-js"
import { expect, test } from "bun:test"

import type { Database } from "@/supabase/types"
import { createAdminClient } from "@/utils/supabase/admin"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "anonymous PKCE upgrade preserves identity and connections, then supports password and local sign-out",
  async () => {
    const mailpit = process.env.MAILPIT_URL
    if (!mailpit) throw new Error("MAILPIT_URL is required when RUN_DB_TESTS=1")
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
    function client() {
      const storage = new Map<string, string>()
      return createClient<Database>(url, key, {
        auth: {
          flowType: "pkce",
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => {
              storage.set(key, value)
            },
            removeItem: (key) => {
              storage.delete(key)
            },
          },
        },
      })
    }
    const admin = createAdminClient()
    const original = client()
    const otherBrowser = client()
    const signedIn = client()
    const duplicate = client()
    const prematurePassword = client()
    const ids = [] as string[]
    const email = `account-${crypto.randomUUID()}@example.test`
    const password = `Password-${crypto.randomUUID()}`
    try {
      const anonymous = await original.auth.signInAnonymously()
      if (anonymous.error) throw anonymous.error
      const id = anonymous.data.user!.id
      ids.push(id)
      const peer = await admin.auth.admin.createUser({
        email: `peer-${email}`,
        password,
        email_confirm: true,
      })
      if (peer.error) throw peer.error
      ids.push(peer.data.user.id)
      const { data: people, error: peopleError } = await admin
        .from("people")
        .select("*")
        .in("auth_user_id", ids)
      if (peopleError) throw peopleError
      const before = people.find((person) => person.auth_user_id === id)!
      const pair = people.map((person) => person.id).sort()
      const connection = { person_1_id: pair[0]!, person_2_id: pair[1]! }
      const seeded = await admin.from("connections").insert(connection)
      if (seeded.error) throw seeded.error
      const deviceId = crypto.randomUUID()
      const device = await admin
        .from("devices")
        .insert({ id: deviceId, person_id: before.id, name: "Upgrade test" })
      if (device.error) throw device.error

      const pending = await original.auth.updateUser(
        { email },
        { emailRedirectTo: "http://localhost:3000/auth/callback" },
      )
      expect(pending.error).toBeNull()
      expect(pending.data.user?.new_email).toBe(email)
      const session = anonymous.data.session!
      expect(
        (await prematurePassword.auth.setSession(session)).error,
      ).toBeNull()
      expect(
        (await prematurePassword.auth.updateUser({ password })).error?.status,
      ).toBe(422)

      let messageId: string | undefined
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await fetch(
          `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
        )
        if (!response.ok) throw new Error("Mailpit search failed")
        const result = (await response.json()) as { messages: { ID: string }[] }
        messageId = result.messages[0]?.ID
        if (messageId) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(messageId).toBeDefined()
      const messageResponse = await fetch(
        `${mailpit}/api/v1/message/${messageId}`,
      )
      if (!messageResponse.ok) throw new Error("Mailpit message fetch failed")
      const message = (await messageResponse.json()) as { HTML: string }
      const link = message.HTML.match(/href="([^"]+)"/)?.[1]?.replaceAll(
        "&amp;",
        "&",
      )
      if (!link) throw new Error("Confirmation link missing")
      const verified = await fetch(link, { redirect: "manual" })
      expect(verified.status).toBe(303)
      const destination = new URL(verified.headers.get("location")!)
      expect(destination.origin + destination.pathname).toBe(
        "http://localhost:3000/auth/callback",
      )
      const code = destination.searchParams.get("code")!
      expect(code).toBeTruthy()
      const wrongBrowser = await otherBrowser.auth.exchangeCodeForSession(code)
      expect(wrongBrowser.error?.code).toBe("pkce_code_verifier_not_found")
      expect((await otherBrowser.auth.getSession()).data.session).toBeNull()
      const confirmed = await original.auth.exchangeCodeForSession(code)
      expect(confirmed.error).toBeNull()
      expect(confirmed.data.user?.id).toBe(id)
      expect(confirmed.data.user?.is_anonymous).toBe(false)
      expect((await original.auth.updateUser({ password })).error).toBeNull()
      const login = await signedIn.auth.signInWithPassword({ email, password })
      expect(login.error).toBeNull()
      expect(login.data.user?.id).toBe(id)
      const after = await admin
        .from("people")
        .select("*")
        .eq("auth_user_id", id)
        .single()
      expect(after.error).toBeNull()
      expect(after.data).toEqual(before)
      const connections = await admin
        .from("connections")
        .select("person_1_id,person_2_id")
        .match(connection)
      expect(connections.error).toBeNull()
      expect(connections.data).toEqual([connection])
      expect((await signedIn.auth.signOut({ scope: "local" })).error).toBeNull()
      expect((await signedIn.auth.getSession()).data.session).toBeNull()
      expect((await original.auth.refreshSession()).data.user?.id).toBe(id)
      expect(
        (await admin.from("devices").select("id").eq("id", deviceId).single())
          .data?.id,
      ).toBe(deviceId)
      const next = await duplicate.auth.signInAnonymously()
      if (next.error) throw next.error
      ids.push(next.data.user!.id)
      expect((await duplicate.auth.updateUser({ email })).error?.code).toBe(
        "email_exists",
      )
    } finally {
      for (const id of ids) {
        const result = await admin.auth.admin.deleteUser(id)
        expect(result.error).toBeNull()
      }
    }
  },
  30_000,
)
