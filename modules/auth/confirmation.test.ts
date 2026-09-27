import { expect, mock, test } from "bun:test"

import { confirmationDestination } from "./confirmation"

test("callback ignores destinations and provider error text", async () => {
  const exchange = mock(async () => ({ error: null }))
  for (const search of [
    "",
    "error=denied&code=secret&error_description=https://evil.test",
    "error=&code=secret",
  ]) {
    expect(
      await confirmationDestination(new URLSearchParams(search), exchange),
    ).toBe("/account?confirmation=failed")
  }
  expect(exchange).not.toHaveBeenCalled()
  expect(
    await confirmationDestination(
      new URLSearchParams("code=secret&next=//evil.test"),
      exchange,
    ),
  ).toBe("/account?confirmation=done")
  expect(exchange).toHaveBeenCalledWith("secret")
})

test("callback maps missing verifier and failed exchanges to fixed destinations", async () => {
  const params = new URLSearchParams("code=secret&next=/\\evil.test")
  expect(
    await confirmationDestination(params, async () => ({
      error: { code: "pkce_code_verifier_not_found" },
    })),
  ).toBe("/account?confirmation=elsewhere")
  expect(
    await confirmationDestination(params, async () => ({
      error: { code: "otp_expired" },
    })),
  ).toBe("/account?confirmation=failed")
  expect(
    await confirmationDestination(params, async () => {
      throw new Error("private")
    }),
  ).toBe("/account?confirmation=failed")
})
