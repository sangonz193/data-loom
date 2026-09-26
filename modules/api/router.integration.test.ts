import { createClient } from "@supabase/supabase-js"
import { createTRPCClient, httpBatchLink } from "@trpc/client"
import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import superjson from "superjson"

import { POST } from "@/app/api/trpc/[trpc]/route"
import { canonicalConnectionIds } from "@/modules/connections/create/connection-ids"
import { createAdminClient } from "@/utils/supabase/admin"

import { createContext } from "./context"
import { appRouter } from "./router"
import type { AppRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "connection deletion requires identity and ownership",
  async () => {
    const admin = createAdminClient()
    const credentials = Array.from({ length: 3 }, (_, index) => ({
      email: `trpc-delete-${crypto.randomUUID()}-${index}@example.test`,
      password: crypto.randomUUID(),
    }))
    const users = await Promise.all(
      credentials.map(({ email, password }) =>
        admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        }),
      ),
    )
    try {
      const authUsers = users.map(({ data, error }) => {
        if (error || !data.user)
          throw error ?? new Error("User creation failed")
        return data.user
      })
      const { data: people, error: peopleError } = await admin
        .from("people")
        .select("id, auth_user_id")
        .in(
          "auth_user_id",
          authUsers.map((user) => user.id),
        )
      if (peopleError) throw peopleError
      const personIds = authUsers.map((user) => {
        const person = people.find((person) => person.auth_user_id === user.id)
        if (!person) throw new Error("Person creation failed")
        return person.id
      })
      const [firstId, secondId, thirdId] = personIds
      if (!firstId || !secondId || !thirdId) throw new Error("Missing person")

      const ownPair = canonicalConnectionIds(firstId, secondId)
      const otherPair = canonicalConnectionIds(secondId, thirdId)
      const { error: insertError } = await admin.from("connections").insert([
        { person_1_id: ownPair[0], person_2_id: ownPair[1] },
        { person_1_id: otherPair[0], person_2_id: otherPair[1] },
      ])
      if (insertError) throw insertError

      const unauthorized = appRouter.createCaller({ userId: null })
      await expect(
        unauthorized.connections.delete({ remotePersonId: secondId }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })

      const owned = appRouter.createCaller({ userId: authUsers[0]!.id })
      await expect(
        owned.connections.delete({ remotePersonId: thirdId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      const { data: remaining, error: remainingError } = await admin
        .from("connections")
        .select("person_1_id")
        .match({ person_1_id: otherPair[0], person_2_id: otherPair[1] })
        .single()
      if (remainingError || !remaining)
        throw remainingError ?? new Error("Other connection was deleted")

      const { data: session, error: sessionError } = await createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      ).auth.signInWithPassword({
        email: credentials[0]!.email,
        password: credentials[0]!.password,
      })
      if (sessionError || !session.session)
        throw sessionError ?? new Error("Sign-in failed")
      const accessToken = session.session.access_token
      const contextForAuthorization = (authorization: string) =>
        createContext(
          new Request("http://localhost/api/trpc", {
            headers: { authorization },
          }),
        )
      const context = await contextForAuthorization(`Bearer ${accessToken}`)
      expect(context.userId).toBe(authUsers[0]!.id)
      expect((await contextForAuthorization("Basic invalid")).userId).toBeNull()
      expect(
        (await contextForAuthorization("Bearer invalid")).userId,
      ).toBeNull()

      const [header, payload, signature] = accessToken.split(".")
      if (!header || !payload || !signature) throw new Error("Invalid token")
      const forgedPayload = Buffer.from(
        JSON.stringify({
          ...(JSON.parse(
            Buffer.from(payload, "base64url").toString(),
          ) as Record<string, unknown>),
          sub: authUsers[2]!.id,
        }),
      ).toString("base64url")
      expect(
        (
          await contextForAuthorization(
            `Bearer ${header}.${forgedPayload}.${signature}`,
          )
        ).userId,
      ).toBeNull()
      const unsupportedHeader = Buffer.from(
        JSON.stringify({
          ...(JSON.parse(Buffer.from(header, "base64url").toString()) as Record<
            string,
            unknown
          >),
          alg: "none",
        }),
      ).toString("base64url")
      expect(
        (
          await contextForAuthorization(
            `Bearer ${unsupportedHeader}.${payload}.${signature}`,
          )
        ).userId,
      ).toBeNull()

      const jwtSecret = process.env.SUPABASE_JWT_SECRET
      if (!jwtSecret) throw new Error("Missing local JWT secret")
      const expiredHeader = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" }),
      ).toString("base64url")
      const expiredPayload = Buffer.from(
        JSON.stringify({
          ...(JSON.parse(
            Buffer.from(payload, "base64url").toString(),
          ) as Record<string, unknown>),
          exp: 1,
        }),
      ).toString("base64url")
      const expiredSignature = createHmac("sha256", jwtSecret)
        .update(`${expiredHeader}.${expiredPayload}`)
        .digest("base64url")
      expect(
        (
          await contextForAuthorization(
            `Bearer ${expiredHeader}.${expiredPayload}.${expiredSignature}`,
          )
        ).userId,
      ).toBeNull()

      const client = createTRPCClient<AppRouter>({
        links: [
          httpBatchLink({
            url: "http://localhost/api/trpc",
            headers: {
              authorization: `Bearer ${accessToken}`,
            },
            transformer: superjson,
            fetch: (input, init) => POST(new Request(input, init)),
          }),
        ],
      })
      await client.connections.delete.mutate({
        remotePersonId: secondId,
      })
      const { data: deleted, error: deletedError } = await admin
        .from("connections")
        .select("person_1_id")
        .match({ person_1_id: ownPair[0], person_2_id: ownPair[1] })
        .maybeSingle()
      if (deletedError) throw deletedError
      expect(deleted).toBeNull()
    } finally {
      await Promise.all(
        users
          .flatMap(({ data }) => (data.user ? [data.user.id] : []))
          .map((userId) => admin.auth.admin.deleteUser(userId)),
      )
    }
  },
)
