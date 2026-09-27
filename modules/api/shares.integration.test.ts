import { expect, test } from "bun:test"

import { canonicalConnectionIds } from "@/modules/connections/create/connection-ids"
import { createAdminClient } from "@/utils/supabase/admin"

import { appRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "share requests enforce identity, ownership, recipients, and expiry",
  async () => {
    const admin = createAdminClient()
    const users = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        admin.auth.admin.createUser({
          email: `trpc-shares-${crypto.randomUUID()}-${index}@example.test`,
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
      const [senderId, recipientId, strangerId] = personIds
      if (!senderId || !recipientId || !strangerId)
        throw new Error("Missing person")

      const [person_1_id, person_2_id] = canonicalConnectionIds(
        senderId,
        recipientId,
      )
      const { error: connectionError } = await admin
        .from("connections")
        .insert({ person_1_id, person_2_id })
      if (connectionError) throw connectionError

      const [
        senderDevice,
        recipientDevice,
        recipientSecondDevice,
        strangerDevice,
      ] = Array.from({ length: 4 }, () => crypto.randomUUID())
      if (
        !senderDevice ||
        !recipientDevice ||
        !recipientSecondDevice ||
        !strangerDevice
      )
        throw new Error("Missing device")
      const { error: deviceError } = await admin.from("devices").insert([
        { id: senderDevice, person_id: senderId, name: "Sender" },
        { id: recipientDevice, person_id: recipientId, name: "Recipient" },
        {
          id: recipientSecondDevice,
          person_id: recipientId,
          name: "Other recipient device",
        },
        { id: strangerDevice, person_id: strangerId, name: "Stranger" },
      ])
      if (deviceError) throw deviceError

      const sender = appRouter.createCaller({ userId: authUsers[0]!.id })
      const recipient = appRouter.createCaller({ userId: authUsers[1]!.id })
      const stranger = appRouter.createCaller({ userId: authUsers[2]!.id })
      const anonymous = appRouter.createCaller({ userId: null })
      const payload = {
        files: [{ name: "hello.txt", size: 5, mimeType: "text/plain" }],
      }
      const requestInput = {
        deviceId: senderDevice,
        toPersonId: recipientId,
        payload,
      }

      await expect(
        anonymous.shares.request(requestInput),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      await expect(
        sender.shares.request({ ...requestInput, deviceId: "invalid" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        sender.shares.request({ ...requestInput, toPersonId: "invalid" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        sender.shares.request({
          ...requestInput,
          payload: { files: [{ ...payload.files[0]!, size: "5" }] } as never,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        sender.shares.request({ ...requestInput, deviceId: recipientDevice }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        sender.shares.request({ ...requestInput, toPersonId: strangerId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        stranger.shares.request({
          ...requestInput,
          deviceId: strangerDevice,
          toPersonId: recipientId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })

      const request = await sender.shares.request(requestInput)
      expect(request.from_person_id).toBe(senderId)
      expect(request.from_device_id).toBe(senderDevice)
      expect(request.to_person_id).toBe(recipientId)
      expect(request.payload).toEqual(payload)
      const lifetime =
        new Date(request.expires_at).getTime() -
        new Date(request.created_at).getTime()
      expect(lifetime).toBeGreaterThan(599_000)
      expect(lifetime).toBeLessThan(601_000)

      const responseInput = {
        requestId: request.id,
        accepted: true,
        deviceId: recipientDevice,
      }
      await expect(
        anonymous.shares.respond(responseInput),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      await expect(
        recipient.shares.respond({ ...responseInput, requestId: "invalid" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        recipient.shares.respond({ ...responseInput, deviceId: "invalid" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        recipient.shares.respond({
          ...responseInput,
          accepted: "true" as never,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        sender.shares.respond({ ...responseInput, deviceId: senderDevice }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(
        stranger.shares.respond({ ...responseInput, deviceId: strangerDevice }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(
        recipient.shares.respond({ ...responseInput, deviceId: senderDevice }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })

      const accepted = await recipient.shares.respond(responseInput)
      expect(accepted.request_id).toBe(request.id)
      expect(accepted.accepted).toBe(true)
      expect(accepted.accepted_by_device_id).toBe(recipientDevice)

      const rejectedRequest = await sender.shares.request(requestInput)
      const rejected = await recipient.shares.respond({
        requestId: rejectedRequest.id,
        accepted: false,
        deviceId: recipientSecondDevice,
      })
      expect(rejected.accepted).toBe(false)
      expect(rejected.accepted_by_device_id).toBeNull()

      const selfRequest = await recipient.shares.request({
        deviceId: recipientDevice,
        toPersonId: recipientId,
        payload,
      })
      const selfResponse = await recipient.shares.respond({
        requestId: selfRequest.id,
        accepted: true,
        deviceId: recipientSecondDevice,
      })
      expect(selfResponse.accepted_by_device_id).toBe(recipientSecondDevice)

      const expiredRequest = await sender.shares.request(requestInput)
      const { error: expiryError } = await admin
        .from("share_requests")
        .update({
          created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .eq("id", expiredRequest.id)
      if (expiryError) throw expiryError
      await expect(
        recipient.shares.respond({
          ...responseInput,
          requestId: expiredRequest.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      const { data: responses, error: responsesError } = await admin
        .from("share_request_responses")
        .select("request_id")
        .in("request_id", [
          request.id,
          rejectedRequest.id,
          selfRequest.id,
          expiredRequest.id,
        ])
      if (responsesError) throw responsesError
      expect(responses).toHaveLength(3)
    } finally {
      await Promise.all(
        users
          .flatMap(({ data }) => (data.user ? [data.user.id] : []))
          .map((id) => admin.auth.admin.deleteUser(id)),
      )
    }
  },
)
