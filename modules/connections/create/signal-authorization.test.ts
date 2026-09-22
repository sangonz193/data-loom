import { expect, test } from "bun:test"

import { canSendSignal } from "./signal-authorization"

test("allows the initial pairing signal before the connection exists", () => {
  expect(
    canSendSignal({
      hasConnection: false,
      fromPersonId: "redeemer",
      toPersonId: "code-owner",
      freshPairingRedemptions: [
        { fromPersonId: "redeemer", codePersonId: "code-owner" },
      ],
    }),
  ).toBe(true)
})

test("allows the pairing response before the connection exists", () => {
  expect(
    canSendSignal({
      hasConnection: false,
      fromPersonId: "code-owner",
      toPersonId: "redeemer",
      freshPairingRedemptions: [
        { fromPersonId: "redeemer", codePersonId: "code-owner" },
      ],
    }),
  ).toBe(true)
})

test("does not authorize signals between unrelated people", () => {
  expect(
    canSendSignal({
      hasConnection: false,
      fromPersonId: "person-a",
      toPersonId: "person-b",
      freshPairingRedemptions: [
        { fromPersonId: "person-c", codePersonId: "person-d" },
      ],
    }),
  ).toBe(false)
})
