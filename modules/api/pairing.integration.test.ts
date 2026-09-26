import { expect, test } from "bun:test"
import { subMinutes } from "date-fns"

import {
  CODE_EXPIRATION_MINUTES,
  CODE_LENGTH,
} from "@/modules/connections/create/constants"
import { createAdminClient } from "@/utils/supabase/admin"

import { appRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "connection pairing creates and redeems only valid owned codes",
  async () => {
    const admin = createAdminClient()
    const users = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        admin.auth.admin.createUser({
          email: `trpc-pairing-${crypto.randomUUID()}-${index}@example.test`,
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
        const person = people.find((person) => person.auth_user_id === user.id)
        if (!person) throw new Error("Person creation failed")
        return person.id
      })
      const [ownerId, redeemerId, otherId] = personIds
      if (!ownerId || !redeemerId || !otherId) throw new Error("Missing person")

      const owner = appRouter.createCaller({ userId: authUsers[0]!.id })
      const redeemer = appRouter.createCaller({ userId: authUsers[1]!.id })
      const other = appRouter.createCaller({ userId: authUsers[2]!.id })
      const anonymous = appRouter.createCaller({ userId: null })

      await expect(anonymous.pairing.create()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      })
      await expect(
        anonymous.pairing.redeem({ code: "ABCD" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" })

      const first = await owner.pairing.create()
      expect(
        new RegExp(`^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{${CODE_LENGTH}}$`).test(
          first.code,
        ),
      ).toBe(true)
      const { data: firstRow, error: firstError } = await admin
        .from("pairing_codes")
        .select("person_id, purpose")
        .eq("code", first.code)
        .single()
      if (firstError) throw firstError
      expect(firstRow).toEqual({ person_id: ownerId, purpose: "connection" })
      await expect(
        owner.pairing.redeem({ code: first.code }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })

      const deviceCode = `D${crypto.randomUUID().slice(0, 12)}`
      const { error: deviceError } = await admin.from("pairing_codes").insert({
        code: deviceCode,
        person_id: ownerId,
        purpose: "device",
      })
      if (deviceError) throw deviceError
      await expect(
        redeemer.pairing.redeem({ code: deviceCode }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      const second = await owner.pairing.create()
      const { data: ownerCodes, error: codesError } = await admin
        .from("pairing_codes")
        .select("code, purpose")
        .eq("person_id", ownerId)
      if (codesError) throw codesError
      expect(ownerCodes.length).toBe(2)
      expect(
        ownerCodes.some(
          ({ code, purpose }) =>
            code === second.code && purpose === "connection",
        ),
      ).toBe(true)
      expect(
        ownerCodes.some(
          ({ code, purpose }) => code === deviceCode && purpose === "device",
        ),
      ).toBe(true)
      await expect(
        redeemer.pairing.redeem({ code: first.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      const { error: expireError } = await admin
        .from("pairing_codes")
        .update({
          created_at: subMinutes(
            new Date(),
            CODE_EXPIRATION_MINUTES + 1,
          ).toISOString(),
        })
        .eq("code", second.code)
      if (expireError) throw expireError
      await expect(
        redeemer.pairing.redeem({ code: second.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      const active = await owner.pairing.create()
      expect(await redeemer.pairing.redeem({ code: active.code })).toEqual({
        remotePersonId: ownerId,
      })
      const { data: redemption, error: redemptionError } = await admin
        .from("pairing_code_redemptions")
        .select("from_person_id")
        .eq("code", active.code)
        .single()
      if (redemptionError) throw redemptionError
      expect(redemption.from_person_id).toBe(redeemerId)

      expect(await other.pairing.redeem({ code: active.code })).toEqual({
        remotePersonId: ownerId,
      })
      const { data: replaced, error: replacedError } = await admin
        .from("pairing_code_redemptions")
        .select("from_person_id")
        .eq("code", active.code)
        .single()
      if (replacedError) throw replacedError
      expect(replaced.from_person_id).toBe(otherId)
    } finally {
      await Promise.all(
        users
          .flatMap(({ data }) => (data.user ? [data.user.id] : []))
          .map((userId) => admin.auth.admin.deleteUser(userId)),
      )
    }
  },
)
