import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { expect, test } from "bun:test"
import { subMinutes } from "date-fns"

import { canonicalConnectionIds } from "@/modules/connections/create/connection-ids"
import { createAdminClient } from "@/utils/supabase/admin"

import { appRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "signals authorize connected and fresh pairs and reach a private device channel",
  async () => {
    const admin = createAdminClient()
    const credentials = Array.from({ length: 3 }, () => ({
      email: `trpc-signals-${crypto.randomUUID()}@example.test`,
      password: crypto.randomUUID(),
    }))
    const users = await Promise.all(
      credentials.map(({ email, password }) =>
        admin.auth.admin.createUser({ email, password, email_confirm: true }),
      ),
    )
    const subscribers: SupabaseClient[] = []
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
      const ids = authUsers.map((user) => {
        const person = people.find((row) => row.auth_user_id === user.id)
        if (!person) throw new Error("Person creation failed")
        return person.id
      })
      const [ownerId, redeemerId, thirdId] = ids
      if (!ownerId || !redeemerId || !thirdId) throw new Error("Missing person")
      const owner = appRouter.createCaller({ userId: authUsers[0]!.id })
      const redeemer = appRouter.createCaller({ userId: authUsers[1]!.id })
      const third = appRouter.createCaller({ userId: authUsers[2]!.id })
      const unauthenticated = appRouter.createCaller({ userId: null })
      const offer = { type: "offer" as const, sdp: "v=0\r\n" }
      const answer = { type: "answer" as const, sdp: "v=0\r\n" }
      const candidate = {
        candidate: "candidate:1 1 udp 1 127.0.0.1 9999 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: "test",
      }

      const ownerDevice = crypto.randomUUID()
      const siblingDevice = crypto.randomUUID()
      const redeemerDevice = crypto.randomUUID()
      const thirdDevice = crypto.randomUUID()
      const { error: deviceError } = await admin.from("devices").insert([
        { id: ownerDevice, person_id: ownerId, name: "Owner" },
        { id: siblingDevice, person_id: ownerId, name: "Sibling" },
        { id: redeemerDevice, person_id: redeemerId, name: "Redeemer" },
        { id: thirdDevice, person_id: thirdId, name: "Third" },
      ])
      if (deviceError) throw deviceError

      await expect(
        unauthenticated.signals.send({
          deviceId: redeemerDevice,
          toDeviceId: ownerDevice,
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
      await expect(
        owner.signals.send({
          deviceId: ownerDevice,
          toDeviceId: "invalid",
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        owner.signals.send({
          deviceId: redeemerDevice,
          toDeviceId: ownerDevice,
          payload: { type: "offer" } as never,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        owner.signals.send({
          deviceId: redeemerDevice,
          toDeviceId: ownerDevice,
          payload: { candidate: 5 } as never,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        owner.signals.send({
          deviceId: ownerDevice,
          toDeviceId: thirdDevice,
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })

      for (const deviceId of [crypto.randomUUID(), redeemerDevice]) {
        await expect(
          owner.signals.send({
            deviceId,
            toDeviceId: siblingDevice,
            payload: offer,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" })
      }
      await expect(
        owner.signals.send({
          deviceId: ownerDevice,
          toDeviceId: crypto.randomUUID(),
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        owner.signals.send({
          deviceId: ownerDevice,
          toDeviceId: ownerDevice,
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })
      await expect(
        owner.signals.send({
          deviceId: "invalid",
          toDeviceId: ownerDevice,
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" })

      const subscribe = async (deviceId: string, credentialIndex: number) => {
        const subscriber = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
        )
        subscribers.push(subscriber)
        const { data: session, error } =
          await subscriber.auth.signInWithPassword(
            credentials[credentialIndex]!,
          )
        if (error || !session.session)
          throw error ?? new Error("Sign-in failed")
        await subscriber.realtime.setAuth(session.session.access_token)
        const messages: unknown[] = []
        const channel = subscriber
          .channel(`device:${deviceId}`, { config: { private: true } })
          .on("broadcast", { event: "signal" }, ({ payload }) =>
            messages.push(payload),
          )
        await new Promise<void>((resolve, reject) => {
          channel.subscribe((status, error) => {
            if (status === "SUBSCRIBED") resolve()
            else if (
              error ||
              status === "CHANNEL_ERROR" ||
              status === "TIMED_OUT"
            )
              reject(error ?? new Error(status))
          })
        })
        return messages
      }
      const received = await subscribe(ownerDevice, 0)
      const siblingReceived = await subscribe(siblingDevice, 0)
      const redeemerReceived = await subscribe(redeemerDevice, 1)
      const waitFor = async (count: number) => {
        const deadline = Date.now() + 3000
        while (received.length < count && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        expect(received).toHaveLength(count)
      }

      await owner.signals.send({
        deviceId: siblingDevice,
        toDeviceId: ownerDevice,
        payload: offer,
        fromPersonId: thirdId,
        fromDeviceId: thirdDevice,
      } as never)
      await waitFor(1)
      expect(received[0]).toEqual({
        fromPersonId: ownerId,
        fromDeviceId: siblingDevice,
        payload: offer,
      })

      const code = (await owner.pairing.create({ purpose: "connection" })).code
      await redeemer.pairing.redeem({ code })
      await expect(third.pairing.redeem({ code })).rejects.toMatchObject({
        code: "FORBIDDEN",
      })
      await redeemer.signals.send({
        deviceId: redeemerDevice,
        toDeviceId: ownerDevice,
        payload: candidate,
      })
      await waitFor(2)
      expect(received[1]).toEqual({
        fromPersonId: redeemerId,
        fromDeviceId: redeemerDevice,
        payload: candidate,
      })
      await owner.signals.send({
        deviceId: ownerDevice,
        toDeviceId: redeemerDevice,
        payload: answer,
      })
      await expect(
        third.signals.send({
          deviceId: thirdDevice,
          toDeviceId: ownerDevice,
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })

      const { error: expireError } = await admin
        .from("pairing_codes")
        .update({ created_at: subMinutes(new Date(), 5.1).toISOString() })
        .eq("code", code)
      if (expireError) throw expireError
      await expect(
        redeemer.signals.send({
          deviceId: redeemerDevice,
          toDeviceId: ownerDevice,
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      await expect(
        owner.signals.send({
          deviceId: ownerDevice,
          toDeviceId: redeemerDevice,
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })

      const wrongCode = `W${crypto.randomUUID().slice(0, 12)}`.toUpperCase()
      const { error: wrongError } = await admin
        .from("pairing_codes")
        .insert({ code: wrongCode, person_id: ownerId, purpose: "device" })
      if (wrongError) throw wrongError
      const { error: wrongRedemptionError } = await admin
        .from("pairing_code_redemptions")
        .insert({ code: wrongCode, from_person_id: redeemerId })
      if (wrongRedemptionError) throw wrongRedemptionError
      await expect(
        redeemer.signals.send({
          deviceId: redeemerDevice,
          toDeviceId: ownerDevice,
          payload: offer,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })

      const [person_1_id, person_2_id] = canonicalConnectionIds(
        ownerId,
        redeemerId,
      )
      const { error: connectionError } = await admin
        .from("connections")
        .insert({ person_1_id, person_2_id })
      if (connectionError) throw connectionError
      await redeemer.signals.send({
        deviceId: redeemerDevice,
        toDeviceId: ownerDevice,
        payload: answer,
      })
      await waitFor(3)
      expect(received[2]).toEqual({
        fromPersonId: redeemerId,
        fromDeviceId: redeemerDevice,
        payload: answer,
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(siblingReceived).toEqual([])
      expect(redeemerReceived).toEqual([
        { fromPersonId: ownerId, fromDeviceId: ownerDevice, payload: answer },
      ])
    } finally {
      await Promise.all(
        subscribers.map((subscriber) => subscriber.removeAllChannels()),
      )
      await Promise.all(
        users.flatMap(({ data }) =>
          data.user ? [admin.auth.admin.deleteUser(data.user.id)] : [],
        ),
      )
    }
  },
)
