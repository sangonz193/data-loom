import { expect, test } from "bun:test"
import { subMinutes } from "date-fns"

import { createAdminClient } from "@/utils/supabase/admin"

import { appRouter } from "./router"

const integrationTest = process.env.RUN_DB_TESTS === "1" ? test : test.skip

integrationTest(
  "connection pairing preserves purpose, expires after five minutes, and keeps the first redeemer",
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
      expect(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(first.code)).toBe(
        true,
      )
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

      const deviceCode = `D${crypto.randomUUID().slice(0, 12)}`.toUpperCase()
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
          created_at: subMinutes(new Date(), 5.1).toISOString(),
        })
        .eq("code", second.code)
      if (expireError) throw expireError
      await expect(
        redeemer.pairing.redeem({ code: second.code }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      const active = await owner.pairing.create()
      const alphabeticCode = `A${active.code.slice(1)}`
      const { error: activeError } = await admin
        .from("pairing_codes")
        .update({
          code: alphabeticCode,
          created_at: subMinutes(new Date(), 4.9).toISOString(),
        })
        .eq("code", active.code)
      if (activeError) throw activeError
      expect(
        await redeemer.pairing.redeem({
          code: ` ${alphabeticCode.toLowerCase()} `,
        }),
      ).toEqual({ remotePersonId: ownerId })
      const { data: redemption, error: redemptionError } = await admin
        .from("pairing_code_redemptions")
        .select("from_person_id, created_at")
        .eq("code", alphabeticCode)
        .single()
      if (redemptionError) throw redemptionError
      expect(redemption.from_person_id).toBe(redeemerId)

      await expect(
        other.pairing.redeem({ code: alphabeticCode }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
      expect(await redeemer.pairing.redeem({ code: alphabeticCode })).toEqual({
        remotePersonId: ownerId,
      })
      const { data: retried, error: retryError } = await admin
        .from("pairing_code_redemptions")
        .select("from_person_id, created_at")
        .eq("code", alphabeticCode)
        .single()
      if (retryError) throw retryError
      expect(retried).toEqual(redemption)

      const { error: expireRetryError } = await admin
        .from("pairing_codes")
        .update({ created_at: subMinutes(new Date(), 5.1).toISOString() })
        .eq("code", alphabeticCode)
      if (expireRetryError) throw expireRetryError
      await expect(
        redeemer.pairing.redeem({ code: alphabeticCode }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })

      const concurrent = await owner.pairing.create()
      const contenders = [
        { caller: redeemer, personId: redeemerId },
        { caller: other, personId: otherId },
      ]
      const attempts = await Promise.allSettled(
        contenders.map(({ caller }) =>
          caller.pairing.redeem({ code: concurrent.code }),
        ),
      )
      expect(
        attempts.filter(({ status }) => status === "fulfilled").length,
      ).toBe(1)
      expect(
        attempts.filter(({ status }) => status === "rejected").length,
      ).toBe(1)
      const { data: winner, error: winnerError } = await admin
        .from("pairing_code_redemptions")
        .select("from_person_id")
        .eq("code", concurrent.code)
        .single()
      if (winnerError) throw winnerError
      for (const [index, attempt] of attempts.entries()) {
        if (attempt.status === "fulfilled") {
          expect(attempt.value).toEqual({ remotePersonId: ownerId })
          expect(winner.from_person_id).toBe(contenders[index]!.personId)
        } else {
          expect(attempt.reason.code).toBe("FORBIDDEN")
        }
      }

      const concurrentRetries = await owner.pairing.create()
      expect(
        await Promise.all(
          Array.from({ length: 4 }, () =>
            redeemer.pairing.redeem({ code: concurrentRetries.code }),
          ),
        ),
      ).toEqual(Array.from({ length: 4 }, () => ({ remotePersonId: ownerId })))
      const { data: retryRows, error: retryRowsError } = await admin
        .from("pairing_code_redemptions")
        .select("from_person_id")
        .eq("code", concurrentRetries.code)
      if (retryRowsError) throw retryRowsError
      expect(retryRows).toEqual([{ from_person_id: redeemerId }])
    } finally {
      await Promise.all(
        users
          .flatMap(({ data }) => (data.user ? [data.user.id] : []))
          .map((userId) => admin.auth.admin.deleteUser(userId)),
      )
    }
  },
)
