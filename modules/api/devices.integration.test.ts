import { expect, test } from "bun:test"

import { createAdminClient } from "@/utils/supabase/admin"

import { appRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "device registration enforces ownership under contention",
  async () => {
    const admin = createAdminClient()
    const users = await Promise.all(
      Array.from({ length: 2 }, (_, index) =>
        admin.auth.admin.createUser({
          email: `trpc-device-${crypto.randomUUID()}-${index}@example.test`,
          password: crypto.randomUUID(),
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
        const person = people.find(
          ({ auth_user_id }) => auth_user_id === user.id,
        )
        if (!person) throw new Error("Person creation failed")
        return person.id
      })
      const [firstPersonId, secondPersonId] = personIds
      if (!firstPersonId || !secondPersonId) throw new Error("Missing person")

      const first = appRouter.createCaller({ userId: authUsers[0]!.id })
      const second = appRouter.createCaller({ userId: authUsers[1]!.id })
      const anonymous = appRouter.createCaller({ userId: null })
      const id = crypto.randomUUID()

      await expect(anonymous.devices.register({ id })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      })
      await expect(
        first.devices.register({ id: "invalid" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      })
      const { data: before, error: beforeError } = await admin
        .from("devices")
        .select("id")
        .eq("id", id)
        .maybeSingle()
      if (beforeError) throw beforeError
      expect(before).toBeNull()

      expect(await first.devices.register({ id })).toEqual({
        id,
        personId: firstPersonId,
      })
      const { data: created, error: createdError } = await admin
        .from("devices")
        .select("person_id, name, last_seen_at")
        .eq("id", id)
        .single()
      if (createdError) throw createdError
      expect(created.person_id).toBe(firstPersonId)
      expect(created.name).toBe("This device")
      expect(created.last_seen_at).toBeTruthy()

      const { error: renameError } = await admin
        .from("devices")
        .update({
          name: "Renamed device",
          last_seen_at: "2020-01-01T00:00:00Z",
        })
        .eq("id", id)
      if (renameError) throw renameError
      expect(await first.devices.register({ id })).toEqual({
        id,
        personId: firstPersonId,
      })
      const { data: repeated, error: repeatedError } = await admin
        .from("devices")
        .select("person_id, name, last_seen_at")
        .eq("id", id)
        .single()
      if (repeatedError) throw repeatedError
      expect(repeated.person_id).toBe(firstPersonId)
      expect(repeated.name).toBe("This device")
      expect(new Date(repeated.last_seen_at).getTime()).toBeGreaterThan(
        new Date("2020-01-01T00:00:00Z").getTime(),
      )

      await expect(second.devices.register({ id })).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
      const { data: retained, error: retainedError } = await admin
        .from("devices")
        .select("person_id")
        .eq("id", id)
        .single()
      if (retainedError) throw retainedError
      expect(retained.person_id).toBe(firstPersonId)

      const competingId = crypto.randomUUID()
      const contenders = [
        { caller: first, personId: firstPersonId },
        { caller: second, personId: secondPersonId },
      ]
      const attempts = await Promise.allSettled(
        contenders.map(({ caller }) =>
          caller.devices.register({ id: competingId }),
        ),
      )
      expect(
        attempts.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1)
      expect(
        attempts.filter(({ status }) => status === "rejected"),
      ).toHaveLength(1)
      const { data: winner, error: winnerError } = await admin
        .from("devices")
        .select("person_id")
        .eq("id", competingId)
        .single()
      if (winnerError) throw winnerError
      for (const [index, attempt] of attempts.entries()) {
        if (attempt.status === "fulfilled") {
          expect(attempt.value).toEqual({
            id: competingId,
            personId: contenders[index]!.personId,
          })
          expect(winner.person_id).toBe(contenders[index]!.personId)
        } else {
          expect(attempt.reason.code).toBe("FORBIDDEN")
        }
      }
    } finally {
      await Promise.all(
        users
          .flatMap(({ data }) => (data.user ? [data.user.id] : []))
          .map((userId) => admin.auth.admin.deleteUser(userId)),
      )
    }
  },
)
