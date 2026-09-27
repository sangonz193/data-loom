import { expect, test } from "bun:test"

import { safeRedirect, withCurrentFragment } from "./safe-redirect"

test("accepts local paths and preserves query and fragment", () => {
  for (const path of [
    "/",
    "/home",
    "/x?y=1#z",
    "/%2fexample.com",
    "/%09/example.com",
  ]) {
    expect(safeRedirect(path)).toBe(path)
    expect(new URL(safeRedirect(path), "https://app.test").origin).toBe(
      "https://app.test",
    )
  }
})

test("forwards the browser fragment through anonymous sign-in", () => {
  expect(withCurrentFragment("/link-device", "#setup=ABCDEFGH")).toBe(
    "/link-device#setup=ABCDEFGH",
  )
  expect(withCurrentFragment("/link-device#existing", "#setup=ABCDEFGH")).toBe(
    "/link-device#existing",
  )
  expect(
    new URL(
      withCurrentFragment("/link-device", "#//evil.test"),
      "https://app.test",
    ).origin,
  ).toBe("https://app.test")
})

test("rejects external URLs and browser authority normalization", () => {
  for (const path of [
    undefined,
    ["/home"],
    "",
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/\t/evil.test",
    "/\n/evil.test",
    "/\r/evil.test",
    "\u0000//evil.test",
    "/a/..//evil.test",
    "/%2e%2e//evil.test",
    "/ \\evil.test",
  ]) {
    expect(safeRedirect(path)).toBe("/home")
  }
  expect(new URL("/\t/evil.test", "https://app.test").origin).toBe(
    "https://evil.test",
  )
  expect(new URL("/\\evil.test", "https://app.test").origin).toBe(
    "https://evil.test",
  )
})
