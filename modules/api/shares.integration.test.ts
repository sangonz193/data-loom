import { createClient } from "@supabase/supabase-js"
import { expect, test } from "bun:test"
import { assign, createActor, fromCallback, fromPromise, waitFor } from "xstate"

import { canonicalConnectionIds } from "@/modules/connections/create/connection-ids"
import { connectionMachine } from "@/modules/connections/item/machine"
import type { Database } from "@/supabase/types"
import { createAdminClient } from "@/utils/supabase/admin"

import { appRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "share requests enforce identity, ownership, recipients, and expiry",
  async () => {
    const admin = createAdminClient()
    const credentials = Array.from({ length: 3 }, (_, index) => ({
      email: `trpc-shares-${crypto.randomUUID()}-${index}@example.test`,
      password: crypto.randomUUID(),
    }))
    const users = await Promise.all(
      credentials.map((credential) =>
        admin.auth.admin.createUser({
          ...credential,
          email_confirm: true,
        }),
      ),
    )
    const subscriber = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )

    const receiverSubscriber = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
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
        requestId: crypto.randomUUID(),
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

      let insertedRequestId: string | undefined
      await expect(
        sender.shares.request(requestInput).then((inserted) => {
          insertedRequestId = inserted.id
          throw new Error("HTTP acknowledgment lost")
        }),
      ).rejects.toThrow("HTTP acknowledgment lost")
      const request = await sender.shares.request(requestInput)
      expect(request.id).toBe(insertedRequestId!)
      expect(request.id).toBe(requestInput.requestId)
      expect(request.from_person_id).toBe(senderId)
      expect(request.from_device_id).toBe(senderDevice)
      expect(request.to_person_id).toBe(recipientId)
      expect(request.payload).toEqual(payload)
      const lifetime =
        new Date(request.expires_at).getTime() -
        new Date(request.created_at).getTime()
      expect(lifetime).toBeGreaterThan(599_000)
      expect(lifetime).toBeLessThan(601_000)
      const { data: original, error: originalError } = await admin
        .from("share_requests")
        .select("id, created_at, expires_at")
        .eq("id", request.id)
        .single()
      if (originalError) throw originalError
      expect(original.created_at).toBe(request.created_at)
      expect(original.expires_at).toBe(request.expires_at)
      const { count, error: countError } = await admin
        .from("share_requests")
        .select("id", { count: "exact", head: true })
        .eq("id", request.id)
      if (countError) throw countError
      expect(count).toBe(1)

      await expect(
        recipient.shares.request({
          ...requestInput,
          deviceId: recipientDevice,
          toPersonId: recipientId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        sender.shares.request({ ...requestInput, deviceId: strangerDevice }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        sender.shares.request({
          ...requestInput,
          payload: { files: [{ ...payload.files[0]!, name: "changed.txt" }] },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      await expect(
        sender.shares.request({ ...requestInput, toPersonId: senderId }),
      ).rejects.toMatchObject({ code: "CONFLICT" })
      const repeated = await sender.shares.request(requestInput)
      expect(repeated).toEqual(request)

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
      expect(await sender.shares.request(requestInput)).toEqual(request)

      const rejectedRequest = await sender.shares.request({
        ...requestInput,
        requestId: crypto.randomUUID(),
      })
      const rejected = await recipient.shares.respond({
        requestId: rejectedRequest.id,
        accepted: false,
        deviceId: recipientSecondDevice,
      })
      expect(rejected.accepted).toBe(false)
      expect(rejected.accepted_by_device_id).toBeNull()
      expect(
        await sender.shares.request({
          ...requestInput,
          requestId: rejectedRequest.id,
        }),
      ).toEqual(rejectedRequest)

      const { data: session, error: signInError } =
        await subscriber.auth.signInWithPassword(credentials[0]!)
      if (signInError || !session.session)
        throw signInError ?? new Error("Sign-in failed")
      await subscriber.realtime.setAuth(session.session.access_token)

      for (const accepted of [true, false]) {
        for (const responseBeforeFailure of [true, false]) {
          const machine = connectionMachine.provide({
            actions: { createPeerConnection: () => undefined },
            actors: {
              connectCallerPeerMachine: fromCallback(() => {}) as never,
            },
          })
          const committed = [] as Awaited<
            ReturnType<typeof sender.shares.request>
          >[]
          const actor = createActor(machine, {
            input: {
              currentUser: authUsers[0]!,
              remoteUserId: recipientId,
              deviceId: senderDevice,
              supabase: subscriber,
              trpcClient: {
                shares: {
                  request: {
                    mutate: async (
                      input: Parameters<typeof sender.shares.request>[0],
                    ) => {
                      const row = await sender.shares.request(input)
                      committed.push(row)
                      if (committed.length === 1) {
                        if (responseBeforeFailure) {
                          await recipient.shares.respond({
                            requestId: row.id,
                            accepted,
                            deviceId: recipientDevice,
                          })
                        }
                        throw new Error("HTTP acknowledgment lost")
                      }
                      return row
                    },
                  },
                },
              } as never,
            },
          }).start()
          try {
            actor.send({
              type: "send-files",
              files: [new File(["hello"], "hello.txt")],
            })
            await waitFor(actor, (state) => state.matches("request failed"), {
              timeout: 5000,
            })
            if (!responseBeforeFailure) {
              await recipient.shares.respond({
                requestId: committed[0]!.id,
                accepted,
                deviceId: recipientDevice,
              })
            }
            actor.send({ type: "retry" })
            await waitFor(
              actor,
              (state) => state.matches(accepted ? "connecting" : "idle"),
              { timeout: 10000 },
            )
            expect(committed).toHaveLength(2)
            expect(committed[1]).toEqual(committed[0]!)
          } finally {
            actor.stop()
          }
        }
      }

      const { data: receiverSession, error: receiverSignInError } =
        await receiverSubscriber.auth.signInWithPassword(credentials[1]!)
      if (receiverSignInError || !receiverSession.session)
        throw receiverSignInError ?? new Error("Receiver sign-in failed")
      await receiverSubscriber.realtime.setAuth(
        receiverSession.session.access_token,
      )
      const incomingRequest = await sender.shares.request({
        ...requestInput,
        requestId: crypto.randomUUID(),
      })
      const offerReceived = Promise.withResolvers<void>()
      const peerConnection = {
        remoteDescription: null as RTCSessionDescriptionInit | null,
        localDescription: { type: "answer", sdp: "v=0\r\n" },
        setRemoteDescription: async (offer: RTCSessionDescriptionInit) => {
          peerConnection.remoteDescription = offer
          offerReceived.resolve()
        },
        setLocalDescription: async () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        close: () => {},
      }
      const committedResponses = [] as Awaited<
        ReturnType<typeof recipient.shares.respond>
      >[]
      let sentOffers = 0
      const receiverMachine = connectionMachine.provide({
        actions: {
          createPeerConnection: assign({
            peerConnection: () =>
              peerConnection as unknown as RTCPeerConnection,
          }),
        },
        actors: {
          receiveFile: fromPromise(() => new Promise(() => {})) as never,
        },
      })
      const receiver = createActor(receiverMachine, {
        input: {
          currentUser: authUsers[1]!,
          remoteUserId: senderId,
          deviceId: recipientDevice,
          supabase: receiverSubscriber,
          trpcClient: {
            shares: {
              respond: {
                mutate: async (
                  input: Parameters<typeof recipient.shares.respond>[0],
                ) => {
                  const response = await recipient.shares.respond(input)
                  committedResponses.push(response)
                  if (committedResponses.length === 1) {
                    sentOffers += 1
                    await sender.signals.send({
                      deviceId: senderDevice,
                      toDeviceId: recipientDevice,
                      payload: { type: "offer", sdp: "v=0\r\n" },
                    })
                    await offerReceived.promise
                    throw new Error("HTTP acknowledgment lost")
                  }
                  return response
                },
              },
            },
            signals: { send: { mutate: recipient.signals.send } },
          } as never,
        },
      }).start()
      try {
        receiver.send({
          type: "connection-request-received",
          request: incomingRequest,
        })
        receiver.send({ type: "accept" })
        const receiverPeer =
          receiver.getSnapshot().children.connectReceiverPeerMachine
        await waitFor(
          receiver,
          (state) =>
            state.matches({ "receiving connection": "acceptance failed" }),
          { timeout: 10_000 },
        )
        expect(peerConnection.remoteDescription).toEqual({
          type: "offer",
          sdp: "v=0\r\n",
        })
        const { data: persistedResponse, error: persistedResponseError } =
          await admin
            .from("share_request_responses")
            .select()
            .eq("request_id", incomingRequest.id)
            .single()
        if (persistedResponseError) throw persistedResponseError
        expect(persistedResponse.accepted).toBe(true)
        expect(persistedResponse.accepted_by_device_id).toBe(recipientDevice)
        receiver.send({ type: "retry" })
        await waitFor(
          receiver,
          (state) =>
            state.matches({ "receiving connection": "connecting with caller" }),
          { timeout: 5000 },
        )
        expect(committedResponses).toHaveLength(2)
        expect(committedResponses[1]!.request_id).toBe(incomingRequest.id)
        expect(sentOffers).toBe(1)
        expect(receiver.getSnapshot().children.connectReceiverPeerMachine).toBe(
          receiverPeer!,
        )
        receiver.send({
          type: "peer.datachannel",
          event: {
            channel: { label: "file:hello.txt" },
          } as RTCDataChannelEvent,
        })
        expect(receiver.getSnapshot().matches("receiving files")).toBe(true)
        expect(
          receiver.getSnapshot().children.connectReceiverPeerMachine,
        ).toBeUndefined()
      } finally {
        receiver.stop()
      }

      const selfRequest = await recipient.shares.request({
        requestId: crypto.randomUUID(),
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

      const expiredRequest = await sender.shares.request({
        ...requestInput,
        requestId: crypto.randomUUID(),
      })
      const { error: expiryError } = await admin
        .from("share_requests")
        .update({
          created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        })
        .eq("id", expiredRequest.id)
      if (expiryError) throw expiryError
      const { data: expiredOriginal, error: expiredOriginalError } = await admin
        .from("share_requests")
        .select()
        .eq("id", expiredRequest.id)
        .single()
      if (expiredOriginalError) throw expiredOriginalError
      await expect(
        sender.shares.request({
          ...requestInput,
          requestId: expiredRequest.id,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Share request expired",
      })
      const { data: expiredAfterRetry, error: expiredAfterRetryError } =
        await admin
          .from("share_requests")
          .select()
          .eq("id", expiredRequest.id)
          .single()
      if (expiredAfterRetryError) throw expiredAfterRetryError
      expect(expiredAfterRetry).toEqual(expiredOriginal)
      await expect(
        recipient.shares.respond({
          ...responseInput,
          requestId: expiredRequest.id,
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })

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
      await receiverSubscriber.removeAllChannels()
      await receiverSubscriber.auth.signOut()
      await subscriber.removeAllChannels()
      await subscriber.auth.signOut()
      await Promise.all(
        users
          .flatMap(({ data }) => (data.user ? [data.user.id] : []))
          .map((id) => admin.auth.admin.deleteUser(id)),
      )
    }
  },
  30_000,
)
