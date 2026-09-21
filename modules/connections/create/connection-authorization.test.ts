import { expect, test } from "bun:test"
import { subMinutes } from "date-fns"

import { canCreateConnection } from "./connection-authorization"
import { CODE_EXPIRATION_MINUTES } from "./constants"

const now = new Date("2026-09-21T12:00:00.000Z")

test("denies an expired pairing redemption", () => {
  expect(
    canCreateConnection({
      personId: "person-a",
      remotePersonId: "person-b",
      pairingRedemptions: [
        {
          fromPersonId: "person-b",
          codePersonId: "person-a",
          codeCreatedAt: subMinutes(
            now,
            CODE_EXPIRATION_MINUTES + 1,
          ).toISOString(),
        },
      ],
      now,
    }),
  ).toBe(false)
})

test("allows a fresh pairing redemption", () => {
  expect(
    canCreateConnection({
      personId: "person-a",
      remotePersonId: "person-b",
      pairingRedemptions: [
        {
          fromPersonId: "person-b",
          codePersonId: "person-a",
          codeCreatedAt: subMinutes(
            now,
            CODE_EXPIRATION_MINUTES - 1,
          ).toISOString(),
        },
      ],
      now,
    }),
  ).toBe(true)
})
