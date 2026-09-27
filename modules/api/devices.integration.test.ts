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
        message: "DEVICE_OWNED_BY_ANOTHER_PERSON",
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

integrationTest(
  "device removal preserves ownership and share lifecycle",
  async () => {
    const admin = createAdminClient()
    const users = await Promise.all(
      Array.from({ length: 2 }, (_, index) =>
        admin.auth.admin.createUser({
          email: `trpc-device-remove-${crypto.randomUUID()}-${index}@example.test`,
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
      const [ownerId, otherId] = authUsers.map((user) => {
        const person = people.find((row) => row.auth_user_id === user.id)
        if (!person) throw new Error("Person creation failed")
        return person.id
      })
      if (!ownerId || !otherId) throw new Error("Missing person")

      const owner = appRouter.createCaller({ userId: authUsers[0]!.id })
      const anonymous = appRouter.createCaller({ userId: null })
      const withoutPerson = appRouter.createCaller({
        userId: crypto.randomUUID(),
      })
      const [
        ownDevice,
        concurrentDevice,
        otherDevice,
        senderDevice,
        acceptedDevice,
      ] = Array.from({ length: 5 }, () => crypto.randomUUID())
      if (
        !ownDevice ||
        !concurrentDevice ||
        !otherDevice ||
        !senderDevice ||
        !acceptedDevice
      )
        throw new Error("Missing device")
      const { error: deviceError } = await admin.from("devices").insert([
        { id: ownDevice, person_id: ownerId, name: "Original" },
        { id: concurrentDevice, person_id: ownerId, name: "Concurrent" },
        { id: otherDevice, person_id: otherId, name: "Other" },
        { id: senderDevice, person_id: ownerId, name: "Sender" },
        { id: acceptedDevice, person_id: ownerId, name: "Accepted" },
      ])
      if (deviceError) throw deviceError

      await expect(
        anonymous.devices.remove({ id: ownDevice }),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      })
      await expect(
        owner.devices.remove({ id: "invalid" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      })
      await expect(
        withoutPerson.devices.remove({ id: ownDevice }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        owner.devices.remove({ id: otherDevice }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
      const { data: foreign, error: foreignError } = await admin
        .from("devices")
        .select("person_id")
        .eq("id", otherDevice)
        .single()
      if (foreignError) throw foreignError
      expect(foreign.person_id).toBe(otherId)
      await expect(
        owner.devices.remove({ id: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      expect(await owner.devices.remove({ id: ownDevice })).toBeUndefined()
      const { data: removed, error: removedError } = await admin
        .from("devices")
        .select("id")
        .eq("id", ownDevice)
        .maybeSingle()
      if (removedError) throw removedError
      expect(removed).toBeNull()

      const attempts = await Promise.allSettled([
        owner.devices.remove({ id: concurrentDevice }),
        owner.devices.remove({ id: concurrentDevice }),
      ])
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1)
      const rejected = attempts.filter(
        (attempt) => attempt.status === "rejected",
      )
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.reason.code).toBe("NOT_FOUND")

      const payload = {
        files: [{ name: "example.txt", size: 1, mimeType: "text/plain" }],
      }
      const outgoingId = crypto.randomUUID()
      const { error: outgoingError } = await admin
        .from("share_requests")
        .insert({
          id: outgoingId,
          from_person_id: ownerId,
          from_device_id: senderDevice,
          to_person_id: otherId,
          payload,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        })
      if (outgoingError) throw outgoingError
      const { error: responseError } = await admin
        .from("share_request_responses")
        .insert({
          request_id: outgoingId,
          accepted: true,
          accepted_by_device_id: otherDevice,
        })
      if (responseError) throw responseError

      expect(await owner.devices.remove({ id: senderDevice })).toBeUndefined()
      const { data: outgoing, error: outgoingReadError } = await admin
        .from("share_requests")
        .select("id")
        .eq("id", outgoingId)
        .maybeSingle()
      if (outgoingReadError) throw outgoingReadError
      expect(outgoing).toBeNull()
      const { data: outgoingResponse, error: outgoingResponseError } =
        await admin
          .from("share_request_responses")
          .select("request_id")
          .eq("request_id", outgoingId)
          .maybeSingle()
      if (outgoingResponseError) throw outgoingResponseError
      expect(outgoingResponse).toBeNull()
      const { data: intent, error: intentError } = await admin
        .from("share_request_intents")
        .select("request_id")
        .match({ from_person_id: ownerId, request_id: outgoingId })
        .single()
      if (intentError) throw intentError
      expect(intent.request_id).toBe(outgoingId)

      const retainedId = crypto.randomUUID()
      const { error: retainedError } = await admin
        .from("share_requests")
        .insert({
          id: retainedId,
          from_person_id: otherId,
          from_device_id: otherDevice,
          to_person_id: ownerId,
          payload,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        })
      if (retainedError) throw retainedError
      const { error: acceptedError } = await admin
        .from("share_request_responses")
        .insert({
          request_id: retainedId,
          accepted: true,
          accepted_by_device_id: acceptedDevice,
        })
      if (acceptedError) throw acceptedError
      expect(await owner.devices.remove({ id: acceptedDevice })).toBeUndefined()
      const { data: retainedRequest, error: retainedRequestError } = await admin
        .from("share_requests")
        .select("id")
        .eq("id", retainedId)
        .single()
      if (retainedRequestError) throw retainedRequestError
      expect(retainedRequest.id).toBe(retainedId)
      const { data: retainedResponse, error: retainedResponseError } =
        await admin
          .from("share_request_responses")
          .select("accepted, accepted_by_device_id")
          .eq("request_id", retainedId)
          .single()
      if (retainedResponseError) throw retainedResponseError
      expect(retainedResponse).toEqual({
        accepted: true,
        accepted_by_device_id: null,
      })

      expect(await owner.devices.register({ id: ownDevice })).toEqual({
        id: ownDevice,
        personId: ownerId,
      })
      const { data: recreated, error: recreatedError } = await admin
        .from("devices")
        .select("person_id, name")
        .eq("id", ownDevice)
        .single()
      if (recreatedError) throw recreatedError
      expect(recreated).toEqual({ person_id: ownerId, name: "This device" })
    } finally {
      await Promise.all(
        users
          .flatMap(({ data }) => (data.user ? [data.user.id] : []))
          .map((userId) => admin.auth.admin.deleteUser(userId)),
      )
    }
  },
)
