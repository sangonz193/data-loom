import { expect, test } from "bun:test"

import { canonicalConnectionIds } from "@/modules/connections/create/connection-ids"
import { createAdminClient } from "@/utils/supabase/admin"

import { appRouter } from "./router"
import { holdShareChange } from "./share-cancellation-locks"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "share cancellation and responses preserve the first committed result",
  async () => {
    if (
      process.env.RUN_DB_TESTS === "1" &&
      (!process.env.DB_URL ||
        !URL.canParse(process.env.DB_URL) ||
        !["postgres:", "postgresql:"].includes(
          new URL(process.env.DB_URL).protocol,
        ))
    )
      throw new Error("DB_URL must be a PostgreSQL URL when RUN_DB_TESTS=1")

    const admin = createAdminClient()
    const users = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        admin.auth.admin.createUser({
          email: `trpc-cancel-${crypto.randomUUID()}-${index}@example.test`,
          password: crypto.randomUUID(),
          email_confirm: true,
        }),
      ),
    )
    const authIds = users.map(({ data, error }) => {
      if (error || !data.user) throw error ?? new Error("User creation failed")
      return data.user.id
    })
    try {
      const { data: people, error: peopleError } = await admin
        .from("people")
        .select("id, auth_user_id")
        .in("auth_user_id", authIds)
      if (peopleError) throw peopleError
      const [senderId, recipientId, strangerId] = authIds.map((authId) => {
        const person = people.find((row) => row.auth_user_id === authId)
        if (!person) throw new Error("Person creation failed")
        return person.id
      })
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
      const [senderDevice, recipientDeviceA, recipientDeviceB, strangerDevice] =
        Array.from({ length: 4 }, () => crypto.randomUUID())
      if (
        !senderDevice ||
        !recipientDeviceA ||
        !recipientDeviceB ||
        !strangerDevice
      )
        throw new Error("Missing device")
      const { error: deviceError } = await admin.from("devices").insert([
        { id: senderDevice, person_id: senderId, name: "Sender" },
        { id: recipientDeviceA, person_id: recipientId, name: "Recipient A" },
        { id: recipientDeviceB, person_id: recipientId, name: "Recipient B" },
        { id: strangerDevice, person_id: strangerId, name: "Stranger" },
      ])
      if (deviceError) throw deviceError

      const sender = appRouter.createCaller({ userId: authIds[0]! })
      const recipient = appRouter.createCaller({ userId: authIds[1]! })
      const stranger = appRouter.createCaller({ userId: authIds[2]! })
      const anonymous = appRouter.createCaller({ userId: null })
      const payload = {
        files: [{ name: "example.txt", size: 1, mimeType: "text/plain" }],
      }
      const createRequest = () =>
        sender.shares.request({
          requestId: crypto.randomUUID(),
          deviceId: senderDevice,
          toPersonId: recipientId,
          payload,
        })
      const expire = async (requestId: string) => {
        const { error } = await admin
          .from("share_requests")
          .update({
            created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
            expires_at: new Date(Date.now() - 60_000).toISOString(),
          })
          .eq("id", requestId)
        if (error) throw error
      }
      const response = (
        requestId: string,
        accepted: boolean,
        deviceId: string,
      ) => recipient.shares.respond({ requestId, accepted, deviceId })

      const cancelledRequest = await createRequest()
      const cancelInput = { requestId: cancelledRequest.id }
      await expect(anonymous.shares.cancel(cancelInput)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      })
      await expect(
        sender.shares.cancel({ requestId: "invalid" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      expect(
        (await sender.shares.cancel({ requestId: crypto.randomUUID() }))
          .cancelled_at,
      ).toBeTruthy()
      await expect(recipient.shares.cancel(cancelInput)).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
      await expect(stranger.shares.cancel(cancelInput)).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
      const cancelled = await sender.shares.cancel(cancelInput)
      expect(cancelled.cancelled_at).toBeTruthy()
      expect(await sender.shares.cancel(cancelInput)).toEqual(cancelled)
      await expect(
        sender.shares.request({
          requestId: cancelledRequest.id,
          deviceId: senderDevice,
          toPersonId: recipientId,
          payload,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Share request cancelled",
      })
      await expect(
        anonymous.shares.respond({
          requestId: cancelled.id,
          accepted: true,
          deviceId: recipientDeviceA,
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      await expect(
        response(cancelled.id, true, "invalid"),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        response(cancelled.id, true, senderDevice),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        stranger.shares.respond({
          requestId: cancelled.id,
          accepted: true,
          deviceId: strangerDevice,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(
        response(cancelled.id, true, recipientDeviceA),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
      const { error: cancelledInsertError } = await admin
        .from("share_request_responses")
        .insert({
          request_id: cancelled.id,
          accepted: true,
          accepted_by_device_id: recipientDeviceA,
        })
      expect(cancelledInsertError?.code).toBe("55000")

      const expiredRequest = await createRequest()
      await expire(expiredRequest.id)
      const expiredCancelled = await sender.shares.cancel({
        requestId: expiredRequest.id,
      })
      expect(expiredCancelled.cancelled_at).toBeTruthy()
      const expiredOpenRequest = await createRequest()
      await expire(expiredOpenRequest.id)
      await expect(
        response(expiredOpenRequest.id, false, recipientDeviceB),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
      const { error: expiredInsertError } = await admin
        .from("share_request_responses")
        .insert({ request_id: expiredOpenRequest.id, accepted: false })
      expect(expiredInsertError?.code).toBe("55000")

      const acceptedRequest = await createRequest()
      const accepted = await response(
        acceptedRequest.id,
        true,
        recipientDeviceA,
      )
      const acceptedCancelled = await sender.shares.cancel({
        requestId: acceptedRequest.id,
      })
      expect(acceptedCancelled.cancelled_at).toBeTruthy()
      expect(
        await response(acceptedRequest.id, true, recipientDeviceA),
      ).toEqual(accepted)
      await expect(
        response(acceptedRequest.id, true, recipientDeviceB),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      await expect(
        response(acceptedRequest.id, false, recipientDeviceB),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      await expire(acceptedRequest.id)
      expect(
        await response(acceptedRequest.id, true, recipientDeviceA),
      ).toEqual(accepted)
      const { data: acceptedAfter, error: acceptedAfterError } = await admin
        .from("share_request_responses")
        .select()
        .eq("request_id", acceptedRequest.id)
        .single()
      if (acceptedAfterError) throw acceptedAfterError
      expect(acceptedAfter).toEqual(accepted)

      const declinedRequest = await createRequest()
      const declined = await response(
        declinedRequest.id,
        false,
        recipientDeviceA,
      )
      expect(
        await response(declinedRequest.id, false, recipientDeviceB),
      ).toEqual(declined)
      await expect(
        response(declinedRequest.id, true, recipientDeviceA),
      ).rejects.toMatchObject({ code: "CONFLICT" })

      if (process.env.DB_URL) {
        const request = await createRequest()
        const heldCancel = await holdShareChange(
          process.env.DB_URL,
          request.id,
          "cancel",
        )
        const pendingResponse = response(request.id, true, recipientDeviceA)
        try {
          await heldCancel.waitForBlocked()
        } finally {
          await heldCancel.release()
        }
        await expect(pendingResponse).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
        })
        const { data: afterCancel, error: afterCancelError } = await admin
          .from("share_request_responses")
          .select("request_id")
          .eq("request_id", request.id)
        if (afterCancelError) throw afterCancelError
        expect(afterCancel).toHaveLength(0)

        const anotherRequest = await createRequest()
        const heldResponse = await holdShareChange(
          process.env.DB_URL,
          anotherRequest.id,
          "respond",
          recipientDeviceA,
        )
        const pendingCancel = sender.shares.cancel({
          requestId: anotherRequest.id,
        })
        try {
          await heldResponse.waitForBlocked()
        } finally {
          await heldResponse.release()
        }
        const cancelledAfterResponse = await pendingCancel
        expect(cancelledAfterResponse.cancelled_at).toBeTruthy()
        const responseAfterCancel = await response(
          anotherRequest.id,
          true,
          recipientDeviceA,
        )
        expect(responseAfterCancel.accepted).toBe(true)
      }

      for (let index = 0; index < 8; index++) {
        const request = await createRequest()
        const results = await Promise.allSettled([
          response(request.id, true, recipientDeviceA),
          response(request.id, true, recipientDeviceB),
          response(request.id, false, recipientDeviceB),
        ])
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1)
        expect(
          results
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason.code),
        ).toEqual(["CONFLICT", "CONFLICT"])
        const { data: rows, error } = await admin
          .from("share_request_responses")
          .select()
          .eq("request_id", request.id)
        if (error) throw error
        expect(rows).toHaveLength(1)
        expect(rows[0]).toEqual(
          results.find((result) => result.status === "fulfilled")!.value,
        )
      }

      for (let index = 0; index < 8; index++) {
        const request = await createRequest()
        const [cancelResult, acceptResult] = await Promise.allSettled([
          sender.shares.cancel({ requestId: request.id }),
          response(request.id, true, recipientDeviceA),
        ])
        expect(cancelResult.status).toBe("fulfilled")
        const { data: rows, error } = await admin
          .from("share_request_responses")
          .select()
          .eq("request_id", request.id)
        if (error) throw error
        if (acceptResult.status === "fulfilled") {
          expect(rows).toEqual([acceptResult.value])
        } else {
          expect(acceptResult.reason.code).toBe("PRECONDITION_FAILED")
          expect(rows).toHaveLength(0)
        }
        await expect(
          response(request.id, false, recipientDeviceB),
        ).rejects.toMatchObject({
          code:
            acceptResult.status === "fulfilled" ?
              "CONFLICT"
            : "PRECONDITION_FAILED",
        })
        const { data: current, error: currentError } = await admin
          .from("share_requests")
          .select("cancelled_at")
          .eq("id", request.id)
          .single()
        if (currentError) throw currentError
        expect(current.cancelled_at).toBeTruthy()
      }
    } finally {
      await Promise.all(authIds.map((id) => admin.auth.admin.deleteUser(id)))
    }
  },
  120_000,
)
