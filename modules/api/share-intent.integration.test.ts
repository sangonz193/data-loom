import { createClient } from "@supabase/supabase-js"
import { expect, test } from "bun:test"

import { fixtureClientIp } from "@/modules/api/fixture-client-ip"
import { canonicalConnectionIds } from "@/modules/connections/create/connection-ids"
import type { Database } from "@/supabase/types"
import { createAdminClient } from "@/utils/supabase/admin"

import { appRouter } from "./router"
import { holdShareIntent } from "./share-intent-locks"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "durable cancellation serializes delayed creates, retries, and foreign UUIDs",
  async () => {
    const databaseUrl = process.env.DB_URL
    if (
      !databaseUrl ||
      !URL.canParse(databaseUrl) ||
      !["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)
    )
      throw new Error("DB_URL must be a PostgreSQL URL when RUN_DB_TESTS=1")

    const admin = createAdminClient()
    const credentials = Array.from({ length: 3 }, () => ({
      email: `share-intent-${crypto.randomUUID()}@example.test`,
      password: crypto.randomUUID(),
    }))
    const users = await Promise.all(
      credentials.map((credential) =>
        admin.auth.admin.createUser({ ...credential, email_confirm: true }),
      ),
    )
    const authIds = users.map(({ data, error }) => {
      if (error || !data.user) throw error ?? new Error("User creation failed")
      return data.user.id
    })
    const browser = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    try {
      const { data: people, error } = await admin
        .from("people")
        .select("id, auth_user_id")
        .in("auth_user_id", authIds)
      if (error) throw error
      const [senderId, recipientId, strangerId] = authIds.map((authId) => {
        const person = people.find((row) => row.auth_user_id === authId)
        if (!person) throw new Error("Person creation failed")
        return person.id
      })
      if (!senderId || !recipientId || !strangerId)
        throw new Error("Missing person")
      const senderDevice = crypto.randomUUID()
      const secondSenderDevice = crypto.randomUUID()
      const strangerDevice = crypto.randomUUID()
      const { error: deviceError } = await admin.from("devices").insert([
        { id: senderDevice, person_id: senderId, name: "Sender" },
        { id: secondSenderDevice, person_id: senderId, name: "Sender B" },
        { id: strangerDevice, person_id: strangerId, name: "Stranger" },
      ])
      if (deviceError) throw deviceError
      const [person_1_id, person_2_id] = canonicalConnectionIds(
        senderId,
        recipientId,
      )
      const { error: connectionError } = await admin
        .from("connections")
        .insert({ person_1_id, person_2_id })
      if (connectionError) throw connectionError

      const sender = appRouter.createCaller({
        clientIp: fixtureClientIp(),
        userId: authIds[0]!,
      })
      const otherInstance = appRouter.createCaller({
        clientIp: fixtureClientIp(),
        userId: authIds[0]!,
      })
      const stranger = appRouter.createCaller({
        clientIp: fixtureClientIp(),
        userId: authIds[2]!,
      })
      const payload = {
        files: [{ name: "file.txt", size: 1, mimeType: "text/plain" }],
      }
      const input = (requestId = crypto.randomUUID()) => ({
        requestId,
        deviceId: senderDevice,
        toPersonId: recipientId,
        payload,
      })
      const row = (requestId: string) => ({
        id: requestId,
        from_person_id: senderId,
        from_device_id: senderDevice,
        to_person_id: recipientId,
        payload,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      })
      const readRequest = async (id: string) => {
        const { data, error } = await admin
          .from("share_requests")
          .select()
          .eq("id", id)
          .maybeSingle()
        if (error) throw error
        return data
      }
      const cancelledError = {
        code: "PRECONDITION_FAILED",
        message: "Share request cancelled",
      }

      const before = input()
      const cancelled = await sender.shares.cancel({
        requestId: before.requestId,
      })
      expect(cancelled.id).toBe(before.requestId)
      expect(cancelled.cancelled_at).toBeTruthy()
      expect(
        await otherInstance.shares.cancel({ requestId: before.requestId }),
      ).toEqual(cancelled)
      for (let retry = 0; retry < 2; retry++)
        await expect(
          otherInstance.shares.request(before),
        ).rejects.toMatchObject(cancelledError)
      expect(await readRequest(before.requestId)).toBeNull()

      const delayed = input()
      const delayedLock = await holdShareIntent(
        databaseUrl,
        "delay-create",
        row(delayed.requestId),
      )
      const lateCreate = sender.shares.request(delayed)
      const lateResult = Promise.allSettled([lateCreate])
      try {
        await delayedLock.waitForBlocked()
        const acknowledged = await otherInstance.shares.cancel({
          requestId: delayed.requestId,
        })
        expect(acknowledged.cancelled_at).toBeTruthy()
        expect(await readRequest(delayed.requestId)).toBeNull()
      } finally {
        await delayedLock.release()
        await lateResult
        await delayedLock.close()
      }
      await expect(lateCreate).rejects.toMatchObject(cancelledError)
      expect(await readRequest(delayed.requestId)).toBeNull()

      const inserting = input()
      const insertLock = await holdShareIntent(
        databaseUrl,
        "create",
        row(inserting.requestId),
      )
      const pendingCancel = otherInstance.shares.cancel({
        requestId: inserting.requestId,
      })
      let acknowledged = false
      const cancelResult = pendingCancel.then(() => {
        acknowledged = true
      })
      try {
        await insertLock.waitForBlocked()
        expect(acknowledged).toBe(false)
        expect(await readRequest(inserting.requestId)).toBeNull()
      } finally {
        await insertLock.release()
        await cancelResult
        await insertLock.close()
      }
      expect(
        (await readRequest(inserting.requestId))?.cancelled_at,
      ).toBeTruthy()
      await expect(sender.shares.request(inserting)).rejects.toMatchObject(
        cancelledError,
      )

      const cancelling = input()
      const cancelLock = await holdShareIntent(
        databaseUrl,
        "cancel",
        row(cancelling.requestId),
      )
      const pendingCreates = [
        sender.shares.request(cancelling),
        otherInstance.shares.request(cancelling),
      ]
      const repeatedCancel = otherInstance.shares.cancel({
        requestId: cancelling.requestId,
      })
      const pendingResults = Promise.allSettled([
        ...pendingCreates,
        repeatedCancel,
      ])
      try {
        await cancelLock.waitForBlocked(3)
      } finally {
        await cancelLock.release()
        await pendingResults
        await cancelLock.close()
      }
      for (const pending of pendingCreates)
        await expect(pending).rejects.toMatchObject(cancelledError)
      expect(await repeatedCancel).toEqual(
        await sender.shares.cancel({ requestId: cancelling.requestId }),
      )
      expect(await readRequest(cancelling.requestId)).toBeNull()

      const sharedUuid = input()
      await stranger.shares.cancel({ requestId: sharedUuid.requestId })
      const duplicates = await Promise.all([
        sender.shares.request(sharedUuid),
        otherInstance.shares.request(sharedUuid),
      ])
      expect(duplicates[0]).toEqual(duplicates[1])
      expect(duplicates[0]!.cancelled_at).toBeNull()
      await expect(
        stranger.shares.cancel({ requestId: sharedUuid.requestId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      await expect(
        stranger.shares.request({
          ...sharedUuid,
          deviceId: strangerDevice,
          toPersonId: strangerId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect(await readRequest(sharedUuid.requestId)).toEqual(duplicates[0]!)
      await expect(
        sender.shares.request({ ...sharedUuid, deviceId: secondSenderDevice }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        sender.shares.request({ ...sharedUuid, toPersonId: senderId }),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      await expect(
        sender.shares.request({ ...sharedUuid, payload: { files: [] } }),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      const cancelledExisting = await sender.shares.cancel({
        requestId: sharedUuid.requestId,
      })
      expect(
        await otherInstance.shares.cancel({ requestId: sharedUuid.requestId }),
      ).toEqual(cancelledExisting)
      expect((await readRequest(sharedUuid.requestId))?.cancelled_at).toBe(
        cancelledExisting.cancelled_at,
      )
      await expect(
        sender.shares.request({ ...sharedUuid, deviceId: secondSenderDevice }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        sender.shares.request({ ...sharedUuid, toPersonId: senderId }),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      await expect(
        sender.shares.request({ ...sharedUuid, payload: { files: [] } }),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      const { error: deleteError } = await admin
        .from("share_requests")
        .delete()
        .eq("id", sharedUuid.requestId)
      if (deleteError) throw deleteError
      await expect(sender.shares.request(sharedUuid)).rejects.toMatchObject(
        cancelledError,
      )
      expect(await readRequest(sharedUuid.requestId)).toBeNull()

      const foreignInsert = input()
      const foreignLock = await holdShareIntent(
        databaseUrl,
        "create",
        row(foreignInsert.requestId),
      )
      try {
        expect(
          (await stranger.shares.cancel({ requestId: foreignInsert.requestId }))
            .cancelled_at,
        ).toBeTruthy()
      } finally {
        await foreignLock.release()
        await foreignLock.close()
      }
      expect(
        (await readRequest(foreignInsert.requestId))?.cancelled_at,
      ).toBeNull()
      await sender.shares.cancel({ requestId: foreignInsert.requestId })

      const rpcInput = {
        sender_id: senderId,
        share_request_id: crypto.randomUUID(),
      }
      expect(
        (await browser.rpc("cancel_share_request", rpcInput)).error,
      ).toMatchObject({
        code: "42501",
        message: "permission denied for function cancel_share_request",
      })
      const { error: loginError } = await browser.auth.signInWithPassword(
        credentials[2]!,
      )
      if (loginError) throw loginError
      expect(
        (await browser.rpc("cancel_share_request", rpcInput)).error,
      ).toMatchObject({
        code: "42501",
        message: "permission denied for function cancel_share_request",
      })
      const { error: intentWriteError } = await browser
        .from("share_request_intents")
        .insert({
          from_person_id: senderId,
          request_id: rpcInput.share_request_id,
          cancelled_at: new Date().toISOString(),
        })
      expect(intentWriteError?.code).toBe("42501")
      const { data: privateIntents, error: intentReadError } = await browser
        .from("share_request_intents")
        .select()
      if (intentReadError) throw intentReadError
      expect(privateIntents).toEqual([])
      const { data: active, error: activeError } = await admin
        .from("share_requests")
        .select("id")
        .eq("from_person_id", senderId)
        .is("cancelled_at", null)
      if (activeError) throw activeError
      expect(active).toEqual([])
    } finally {
      await browser.auth.signOut()
      await Promise.all(authIds.map((id) => admin.auth.admin.deleteUser(id)))
    }
  },
  60_000,
)
