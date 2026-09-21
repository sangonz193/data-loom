import { expect, test } from "bun:test"

import { canonicalConnectionIds } from "./connection-ids"

test("canonicalizes a connection regardless of redemption direction", () => {
  expect(canonicalConnectionIds("b", "a")).toEqual(["a", "b"])
  expect(canonicalConnectionIds("a", "b")).toEqual(["a", "b"])
})
