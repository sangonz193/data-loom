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

test("allows either redemption direction but rejects an unrelated owner", () => {
  const redemption = {
    fromPersonId: "person-a",
    codePersonId: "person-b",
    codeCreatedAt: now.toISOString(),
  }

  expect(
    canCreateConnection({
      personId: "person-a",
      remotePersonId: "person-b",
      pairingRedemptions: [redemption],
      now,
    }),
  ).toBe(true)
  expect(
    canCreateConnection({
      personId: "person-b",
      remotePersonId: "person-a",
      pairingRedemptions: [redemption],
      now,
    }),
  ).toBe(true)
  expect(
    canCreateConnection({
      personId: "person-a",
      remotePersonId: "person-c",
      pairingRedemptions: [redemption],
      now,
    }),
  ).toBe(false)
})
