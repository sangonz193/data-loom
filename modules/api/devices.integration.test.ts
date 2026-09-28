import { createClient } from "@supabase/supabase-js"
import { expect, test } from "bun:test"

import type { Database } from "@/supabase/types"
import { createAdminClient } from "@/utils/supabase/admin"

import { holdDeviceLinkRows } from "./device-link-locks"
import { appRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "registration replaces only the owner's exact legacy device name",
  async () => {
    const admin = createAdminClient()
    const users = await Promise.all(
      ["owner", "foreign"].map((label) =>
        admin.auth.admin.createUser({
          email: `device-name-${label}-${crypto.randomUUID()}@example.test`,
          password: crypto.randomUUID(),
          email_confirm: true,
        }),
      ),
    )
    try {
      const authIds = users.map(({ data, error }) => {
        if (error || !data.user)
          throw error ?? new Error("User creation failed")
        return data.user.id
      })
      const { data: people, error: peopleError } = await admin
        .from("people")
        .select("id, auth_user_id")
        .in("auth_user_id", authIds)
      if (peopleError) throw peopleError
      const personId = (authId: string) => {
        const person = people.find((row) => row.auth_user_id === authId)
        if (!person) throw new Error("Person creation failed")
        return person.id
      }
      const ownerId = personId(authIds[0]!)
      const foreignId = personId(authIds[1]!)
      const owner = appRouter.createCaller({ userId: authIds[0]! })
      const legacyId = crypto.randomUUID()
      const foreignDeviceId = crypto.randomUUID()
      const names = ["Laptop", "this device", "This Device", "This device  "]
      const customIds = names.map(() => crypto.randomUUID())
      const oldLastSeen = "2020-01-01T00:00:00Z"
      const { error: insertError } = await admin.from("devices").insert([
        {
          id: legacyId,
          person_id: ownerId,
          name: "This device",
          last_seen_at: oldLastSeen,
        },
        ...customIds.map((id, index) => ({
          id,
          person_id: ownerId,
          name: names[index]!,
          last_seen_at: oldLastSeen,
        })),
        {
          id: foreignDeviceId,
          person_id: foreignId,
          name: "This device",
          last_seen_at: oldLastSeen,
        },
      ])
      if (insertError) throw insertError

      await owner.devices.register({ id: legacyId, name: "Chrome on macOS" })
      for (const id of customIds)
        await owner.devices.register({ id, name: "Chrome on macOS" })
      const { data: updated, error: updateError } = await admin
        .from("devices")
        .select("id, name, last_seen_at")
        .in("id", [legacyId, ...customIds])
      if (updateError) throw updateError
      expect(updated.find(({ id }) => id === legacyId)?.name).toBe(
        "Chrome on macOS",
      )
      for (const [index, id] of customIds.entries())
        expect(updated.find((device) => device.id === id)?.name).toBe(
          names[index],
        )
      for (const device of updated)
        expect(new Date(device.last_seen_at).getTime()).toBeGreaterThan(
          new Date(oldLastSeen).getTime(),
        )

      await owner.devices.rename({ id: legacyId, name: "This device" })
      await owner.devices.register({ id: legacyId, name: "Firefox on Linux" })
      const { data: renamed, error: renameError } = await admin
        .from("devices")
        .select("name")
        .eq("id", legacyId)
        .single()
      if (renameError) throw renameError
      expect(renamed.name).toBe("Firefox on Linux")

      await expect(
        owner.devices.register({
          id: foreignDeviceId,
          name: "Chrome on macOS",
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "DEVICE_OWNED_BY_ANOTHER_PERSON",
      })
      const { data: foreign, error: foreignError } = await admin
        .from("devices")
        .select("person_id, name, last_seen_at")
        .eq("id", foreignDeviceId)
        .single()
      if (foreignError) throw foreignError
      expect(foreign.person_id).toBe(foreignId)
      expect(foreign.name).toBe("This device")
      expect(new Date(foreign.last_seen_at).getTime()).toBe(
        new Date(oldLastSeen).getTime(),
      )
    } finally {
      await Promise.all(
        users.flatMap(({ data }) =>
          data.user ? [admin.auth.admin.deleteUser(data.user.id)] : [],
        ),
      )
    }
  },
)

integrationTest(
  "registration preserves a rename committed while its name update waits",
  async () => {
    const databaseUrl = process.env.DB_URL
    if (!databaseUrl) throw new Error("DB_URL is required")
    const admin = createAdminClient()
    const { data, error } = await admin.auth.admin.createUser({
      email: `device-rename-race-${crypto.randomUUID()}@example.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    })
    if (error || !data.user) throw error ?? new Error("User creation failed")
    const authId = data.user.id
    let hold: Awaited<ReturnType<typeof holdDeviceLinkRows>> | undefined
    try {
      const { data: person, error: personError } = await admin
        .from("people")
        .select("id")
        .eq("auth_user_id", authId)
        .single()
      if (personError) throw personError
      const id = crypto.randomUUID()
      const { error: insertError } = await admin.from("devices").insert({
        id,
        person_id: person.id,
        name: "This device",
      })
      if (insertError) throw insertError
      hold = await holdDeviceLinkRows(databaseUrl, {
        hold: [
          ["select id from public.devices where id = $1 for update", [id]],
        ],
        finish: [
          ["update public.devices set name = 'Desk' where id = $1", [id]],
        ],
      })
      const registration = appRouter
        .createCaller({ userId: authId })
        .devices.register({ id, name: "Chrome on macOS" })
      await hold.waitForBlocked()
      await hold.release()
      await registration
      const { data: device, error: deviceError } = await admin
        .from("devices")
        .select("name")
        .eq("id", id)
        .single()
      if (deviceError) throw deviceError
      expect(device.name).toBe("Desk")
    } finally {
      await hold?.close()
      await admin.auth.admin.deleteUser(authId)
    }
  },
)

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

      await expect(
        anonymous.devices.register({ id, name: "Browser" }),
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      })
      await expect(
        first.devices.register({ id: "invalid", name: "Browser" }),
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

      expect(
        await first.devices.register({ id, name: "Chrome on macOS" }),
      ).toEqual({
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
      expect(created.name).toBe("Chrome on macOS")
      expect(created.last_seen_at).toBeTruthy()

      const { error: renameError } = await admin
        .from("devices")
        .update({
          name: "Renamed device",
          last_seen_at: "2020-01-01T00:00:00Z",
        })
        .eq("id", id)
      if (renameError) throw renameError
      expect(
        await first.devices.register({ id, name: "Chrome on macOS" }),
      ).toEqual({
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
      expect(repeated.name).toBe("Renamed device")
      expect(new Date(repeated.last_seen_at).getTime()).toBeGreaterThan(
        new Date("2020-01-01T00:00:00Z").getTime(),
      )

      await expect(
        second.devices.register({ id, name: "Firefox" }),
      ).rejects.toMatchObject({
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
          caller.devices.register({ id: competingId, name: "Browser" }),
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

      expect(
        await owner.devices.register({
          id: ownDevice,
          name: "Chrome on Linux",
        }),
      ).toEqual({
        id: ownDevice,
        personId: ownerId,
      })
      const { data: recreated, error: recreatedError } = await admin
        .from("devices")
        .select("person_id, name")
        .eq("id", ownDevice)
        .single()
      if (recreatedError) throw recreatedError
      expect(recreated).toEqual({ person_id: ownerId, name: "Chrome on Linux" })
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
  "rename and browser device access stay scoped to the owner",
  async () => {
    const admin = createAdminClient()
    const password = crypto.randomUUID()
    const email = `device-rename-${crypto.randomUUID()}@example.test`
    const users = await Promise.all([
      admin.auth.admin.createUser({ email, password, email_confirm: true }),
      admin.auth.admin.createUser({
        email: `device-foreign-${crypto.randomUUID()}@example.test`,
        password: crypto.randomUUID(),
        email_confirm: true,
      }),
    ])
    try {
      const ownerId = users[0].data.user?.id
      const foreignId = users[1].data.user?.id
      if (!ownerId || !foreignId) throw new Error("User creation failed")
      const owner = appRouter.createCaller({ userId: ownerId })
      const foreign = appRouter.createCaller({ userId: foreignId })
      const anonymous = appRouter.createCaller({ userId: null })
      const ownDevice = crypto.randomUUID()
      const foreignDevice = crypto.randomUUID()
      await owner.devices.register({ id: ownDevice, name: "Chrome" })
      await foreign.devices.register({ id: foreignDevice, name: "Firefox" })

      await expect(
        anonymous.devices.rename({ id: ownDevice, name: "New" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      for (const name of ["", "   ", "a".repeat(65), "a\nb"])
        await expect(
          owner.devices.rename({ id: ownDevice, name }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        owner.devices.rename({ id: foreignDevice, name: "Wrong" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(
        owner.devices.rename({ id: crypto.randomUUID(), name: "Missing" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      const { data: before, error: beforeError } = await admin
        .from("devices")
        .select("last_seen_at")
        .eq("id", ownDevice)
        .single()
      if (beforeError) throw beforeError
      expect(
        await owner.devices.rename({ id: ownDevice, name: "  Laptop  " }),
      ).toEqual({ id: ownDevice, name: "Laptop" })
      const { data: renamed, error: renamedError } = await admin
        .from("devices")
        .select("name, last_seen_at")
        .eq("id", ownDevice)
        .single()
      if (renamedError) throw renamedError
      expect(renamed).toEqual({
        name: "Laptop",
        last_seen_at: before.last_seen_at,
      })
      const { data: untouched, error: untouchedError } = await admin
        .from("devices")
        .select("name")
        .eq("id", foreignDevice)
        .single()
      if (untouchedError) throw untouchedError
      expect(untouched.name).toBe("Firefox")

      const browser = createClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      const { error: signInError } = await browser.auth.signInWithPassword({
        email,
        password,
      })
      if (signInError) throw signInError
      const { data: visible, error: selectError } = await browser
        .from("devices")
        .select("id, name")
      if (selectError) throw selectError
      expect(visible).toEqual([{ id: ownDevice, name: "Laptop" }])
      const { data: updated, error: updateError } = await browser
        .from("devices")
        .update({ name: "Browser write" })
        .eq("id", ownDevice)
        .select("id")
      expect(updateError).toBeNull()
      expect(updated).toEqual([])
      const { data: deleted, error: deleteError } = await browser
        .from("devices")
        .delete()
        .eq("id", ownDevice)
        .select("id")
      expect(deleteError).toBeNull()
      expect(deleted).toEqual([])
      const { error: insertError } = await browser.from("devices").insert({
        id: crypto.randomUUID(),
        person_id: (
          await owner.devices.register({ id: ownDevice, name: "Chrome" })
        ).personId,
        name: "Browser",
      })
      expect(insertError?.code).toBe("42501")
      const { data: retained, error: retainedError } = await admin
        .from("devices")
        .select("name")
        .eq("id", ownDevice)
        .single()
      if (retainedError) throw retainedError
      expect(retained.name).toBe("Laptop")

      await owner.devices.remove({ id: ownDevice })
      await expect(
        owner.devices.rename({ id: ownDevice, name: "Missing" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await owner.devices.register({ id: ownDevice, name: "Safari on macOS" })
      const { data: recreated, error: recreatedError } = await admin
        .from("devices")
        .select("name")
        .eq("id", ownDevice)
        .single()
      if (recreatedError) throw recreatedError
      expect(recreated.name).toBe("Safari on macOS")

      const { error: personDeleteError } = await admin
        .from("people")
        .delete()
        .eq("auth_user_id", ownerId)
      if (personDeleteError) throw personDeleteError
      await expect(
        owner.devices.rename({ id: ownDevice, name: "No person" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    } finally {
      await Promise.all(
        users.flatMap(({ data }) =>
          data.user ? [admin.auth.admin.deleteUser(data.user.id)] : [],
        ),
      )
    }
  },
)
