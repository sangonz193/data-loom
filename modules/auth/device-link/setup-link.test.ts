import { expect, test } from "bun:test"

import { maskEmail, parseSetupLink, setupLinkUrl } from "./setup-link"

test("setup URL contains only a code and masked hint in its fragment", () => {
  const url = new URL(
    setupLinkUrl("https://app.test", "ABCDEFGH", "Sarah@Example.test"),
  )
  expect(url.pathname).toBe("/link-device")
  expect(url.search).toBe("")
  expect(parseSetupLink(url.hash)).toEqual({
    code: "ABCDEFGH",
    hint: "s***@example.test",
  })
  expect(url.href).not.toContain("Sarah")
})

test("email masking excludes unusable or unsafe hints", () => {
  expect(maskEmail("A@Example.test")).toBe("a***@example.test")
  for (const email of [
    undefined,
    "",
    "@example.test",
    "!a@example.test",
    "a@localhost",
    "a@example.test\n",
  ])
    expect(maskEmail(email)).toBeUndefined()
})

test("setup parser rejects invalid codes and drops untrusted hints", () => {
  for (const hash of [
    "#hint=a***@example.test",
    "#setup=ABC",
    "#setup=ABCDEFG0",
    "#setup=ABCDEFGO",
    "#setup=ABCDEFG1",
    "#setup=ABCDEFGI",
    `#setup=ABCDEFGH&extra=${"x".repeat(10_000)}`,
  ])
    expect(parseSetupLink(hash)).toBeUndefined()
  for (const hint of [
    "<img>",
    "a***@example.test%0A",
    "javascript:alert(1)",
    "a@example.test",
  ])
    expect(parseSetupLink(`#setup=ABCDEFGH&hint=${hint}`)).toEqual({
      code: "ABCDEFGH",
    })
  expect(parseSetupLink("#setup=ABCDEFGH&other=ok")).toEqual({
    code: "ABCDEFGH",
  })
})

test("generated setup links roundtrip encoded hints through the length boundary", () => {
  for (const lastLabelLength of [57, 58, 59, 60]) {
    const domain = [
      ...Array(3).fill("a".repeat(63)),
      "b".repeat(lastLabelLength),
    ].join(".")
    const email = `s@${domain}`
    const hint = `s***@${domain}`
    const url = new URL(setupLinkUrl("https://app.test", "ABCDEFGH", email))
    expect(parseSetupLink(url.hash)).toEqual({
      code: "ABCDEFGH",
      ...(hint.length <= 255 ? { hint } : {}),
    })
    if (hint.length <= 255) {
      expect(url.hash).toContain("%40")
      expect(url.hash.length).toBe(23 + hint.length)
    } else {
      expect(url.hash).toBe("#setup=ABCDEFGH")
    }
  }
})

test("setup parser bounds input at the longest generated fragment", () => {
  const hash = `#setup=ABCDEFGH&hint=s***%40${"a".repeat(248)}.b`
  expect(hash.length).toBe(278)
  expect(parseSetupLink(hash)?.code).toBe("ABCDEFGH")
  expect(parseSetupLink(`${hash}b`)).toBeUndefined()
})
