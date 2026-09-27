import { TRPCError } from "@trpc/server"
import { addMinutes, subMinutes } from "date-fns"
import { z } from "zod"

import { canCreateConnection } from "@/modules/connections/create/connection-authorization"
import {
  CODE_EXPIRATION_MINUTES,
  CODE_LENGTH,
} from "@/modules/connections/create/constants"
import { requestPayloadSchema } from "@/modules/connections/file-sharing-requests/payload"
import { createAdminClient } from "@/utils/supabase/admin"

import { getConnectionRedemptions } from "./connection-redemptions"
import { sendPairingRedemption } from "./pairing-redemption-delivery"
import { protectedProcedure, router } from "./trpc"
import { canonicalConnectionIds } from "../connections/create/connection-ids"

export const appRouter = router({
  shares: router({
    request: protectedProcedure
      .input(
        z.object({
          deviceId: z.uuid(),
          toPersonId: z.uuid(),
          payload: requestPayloadSchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const admin = createAdminClient()
        const { data: person, error: personError } = await admin
          .from("people")
          .select("id")
          .eq("auth_user_id", ctx.userId)
          .maybeSingle()
        if (personError) throw personError
        if (!person) throw new TRPCError({ code: "FORBIDDEN" })

        const { data: device, error: deviceError } = await admin
          .from("devices")
          .select("id")
          .match({ id: input.deviceId, person_id: person.id })
          .maybeSingle()
        if (deviceError) throw deviceError
        if (!device) throw new TRPCError({ code: "FORBIDDEN" })

        if (person.id !== input.toPersonId) {
          const [person_1_id, person_2_id] = canonicalConnectionIds(
            person.id,
            input.toPersonId,
          )
          const { data: connection, error: connectionError } = await admin
            .from("connections")
            .select("person_1_id")
            .match({ person_1_id, person_2_id })
            .maybeSingle()
          if (connectionError) throw connectionError
          if (!connection) throw new TRPCError({ code: "FORBIDDEN" })
        }

        const { data, error } = await admin
          .from("share_requests")
          .insert({
            from_person_id: person.id,
            from_device_id: device.id,
            to_person_id: input.toPersonId,
            payload: input.payload,
            expires_at: addMinutes(new Date(), 10).toISOString(),
          })
          .select()
          .single()
        if (error) throw error
        return data
      }),
    respond: protectedProcedure
      .input(
        z.object({
          requestId: z.uuid(),
          accepted: z.boolean(),
          deviceId: z.uuid(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const admin = createAdminClient()
        const { data: person, error: personError } = await admin
          .from("people")
          .select("id")
          .eq("auth_user_id", ctx.userId)
          .maybeSingle()
        if (personError) throw personError
        if (!person) throw new TRPCError({ code: "FORBIDDEN" })

        const { data: request, error: requestError } = await admin
          .from("share_requests")
          .select("id")
          .match({ id: input.requestId, to_person_id: person.id })
          .gt("expires_at", new Date().toISOString())
          .maybeSingle()
        if (requestError) throw requestError
        if (!request) throw new TRPCError({ code: "NOT_FOUND" })

        const { data: device, error: deviceError } = await admin
          .from("devices")
          .select("id")
          .match({ id: input.deviceId, person_id: person.id })
          .maybeSingle()
        if (deviceError) throw deviceError
        if (!device) throw new TRPCError({ code: "FORBIDDEN" })

        const { data, error } = await admin
          .from("share_request_responses")
          .upsert({
            request_id: request.id,
            accepted: input.accepted,
            accepted_by_device_id: input.accepted ? device.id : null,
          })
          .select()
          .single()
        if (error) throw error
        return data
      }),
  }),
  devices: router({
    register: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        const admin = createAdminClient()
        const { data: person, error: personError } = await admin
          .from("people")
          .select("id")
          .eq("auth_user_id", ctx.userId)
          .maybeSingle()
        if (personError) throw personError
        if (!person) throw new TRPCError({ code: "FORBIDDEN" })

        const lastSeenAt = new Date().toISOString()
        const { error: insertError } = await admin.from("devices").upsert(
          {
            id: input.id,
            person_id: person.id,
            name: "This device",
            last_seen_at: lastSeenAt,
          },
          { onConflict: "id", ignoreDuplicates: true },
        )
        if (insertError) throw insertError

        const { data: device, error: updateError } = await admin
          .from("devices")
          .update({ name: "This device", last_seen_at: lastSeenAt })
          .match({ id: input.id, person_id: person.id })
          .select("id")
          .maybeSingle()
        if (updateError) throw updateError
        if (!device)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "DEVICE_OWNED_BY_ANOTHER_PERSON",
          })
        return { id: device.id, personId: person.id }
      }),
  }),
  pairing: router({
    create: protectedProcedure.mutation(async ({ ctx }) => {
      const admin = createAdminClient()
      const { data: person, error: personError } = await admin
        .from("people")
        .select("id")
        .eq("auth_user_id", ctx.userId)
        .maybeSingle()
      if (personError) throw personError
      if (!person) throw new TRPCError({ code: "FORBIDDEN" })

      const { error: deleteError } = await admin
        .from("pairing_codes")
        .delete()
        .match({ person_id: person.id, purpose: "connection" })
      if (deleteError) throw deleteError

      const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
      const values = crypto.getRandomValues(new Uint32Array(CODE_LENGTH))
      const code = Array.from(
        values,
        (value) => alphabet[value % alphabet.length],
      ).join("")
      const { data, error } = await admin
        .from("pairing_codes")
        .insert({ code, person_id: person.id, purpose: "connection" })
        .select("code, created_at")
        .single()
      if (error) throw error
      return data
    }),
    redeem: protectedProcedure
      .input(z.object({ code: z.string().trim().min(1).max(32).toUpperCase() }))
      .mutation(async ({ ctx, input }) => {
        const admin = createAdminClient()
        const { data: person, error: personError } = await admin
          .from("people")
          .select("id")
          .eq("auth_user_id", ctx.userId)
          .maybeSingle()
        if (personError) throw personError
        if (!person) throw new TRPCError({ code: "FORBIDDEN" })

        const { data: pairingCode, error } = await admin
          .from("pairing_codes")
          .select("code, person_id")
          .eq("code", input.code)
          .eq("purpose", "connection")
          .gte(
            "created_at",
            subMinutes(new Date(), CODE_EXPIRATION_MINUTES).toISOString(),
          )
          .maybeSingle()
        if (error) throw error
        if (!pairingCode) throw new TRPCError({ code: "NOT_FOUND" })
        if (pairingCode.person_id === person.id)
          throw new TRPCError({ code: "FORBIDDEN" })

        const { error: redemptionError } = await admin
          .from("pairing_code_redemptions")
          .upsert(
            { code: pairingCode.code, from_person_id: person.id },
            { onConflict: "code", ignoreDuplicates: true },
          )
        if (redemptionError) throw redemptionError

        const { data: redemption, error: existingError } = await admin
          .from("pairing_code_redemptions")
          .select("from_person_id")
          .eq("code", pairingCode.code)
          .maybeSingle()
        if (existingError) throw existingError
        if (!redemption) throw new TRPCError({ code: "NOT_FOUND" })
        if (redemption.from_person_id !== person.id)
          throw new TRPCError({ code: "FORBIDDEN" })

        return { remotePersonId: pairingCode.person_id }
      }),
    notifyRedeemed: protectedProcedure
      .input(z.object({ code: z.string().trim().min(1).max(32).toUpperCase() }))
      .mutation(async ({ ctx, input }) => {
        const admin = createAdminClient()
        const { data: person, error: personError } = await admin
          .from("people")
          .select("id")
          .eq("auth_user_id", ctx.userId)
          .maybeSingle()
        if (personError) throw personError
        if (!person) throw new TRPCError({ code: "FORBIDDEN" })

        const { data: redemption, error } = await admin
          .from("pairing_code_redemptions")
          .select("code, pairing_codes!inner(person_id, purpose, created_at)")
          .match({ code: input.code, from_person_id: person.id })
          .eq("pairing_codes.purpose", "connection")
          .gte(
            "pairing_codes.created_at",
            subMinutes(new Date(), CODE_EXPIRATION_MINUTES).toISOString(),
          )
          .maybeSingle()
        if (error) throw error
        if (!redemption) throw new TRPCError({ code: "NOT_FOUND" })

        const { data: devices, error: devicesError } = await admin
          .from("devices")
          .select("id")
          .eq("person_id", redemption.pairing_codes.person_id)
        if (devicesError) throw devicesError
        await sendPairingRedemption(
          admin,
          devices.map((device) => device.id),
          { remotePersonId: person.id, code: redemption.code },
        )
      }),
  }),
  connections: router({
    create: protectedProcedure
      .input(z.object({ remotePersonId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        const admin = createAdminClient()
        const { data: person, error: personError } = await admin
          .from("people")
          .select("id")
          .eq("auth_user_id", ctx.userId)
          .maybeSingle()
        if (personError) throw personError
        if (!person) throw new TRPCError({ code: "FORBIDDEN" })

        const { data: redemptions, error } = await getConnectionRedemptions(
          admin,
          person.id,
          input.remotePersonId,
        )
        if (error) throw error
        if (
          !canCreateConnection({
            personId: person.id,
            remotePersonId: input.remotePersonId,
            pairingRedemptions: redemptions.map((redemption) => ({
              fromPersonId: redemption.from_person_id,
              codePersonId: redemption.pairing_codes.person_id,
              codeCreatedAt: redemption.pairing_codes.created_at,
            })),
          })
        )
          throw new TRPCError({ code: "NOT_FOUND" })

        const [person_1_id, person_2_id] = canonicalConnectionIds(
          person.id,
          input.remotePersonId,
        )
        const { error: insertError } = await admin
          .from("connections")
          .upsert({ person_1_id, person_2_id })
        if (insertError) throw insertError
      }),
    delete: protectedProcedure
      .input(z.object({ remotePersonId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        const admin = createAdminClient()
        const { data: person, error: personError } = await admin
          .from("people")
          .select("id")
          .eq("auth_user_id", ctx.userId)
          .maybeSingle()
        if (personError) throw personError
        if (!person) throw new TRPCError({ code: "FORBIDDEN" })

        const [person_1_id, person_2_id] = canonicalConnectionIds(
          person.id,
          input.remotePersonId,
        )
        const { data, error } = await admin
          .from("connections")
          .delete()
          .match({ person_1_id, person_2_id })
          .select("person_1_id")
          .maybeSingle()
        if (error) throw error
        if (!data) throw new TRPCError({ code: "NOT_FOUND" })
      }),
  }),
})

export type AppRouter = typeof appRouter
