import { expect, test } from "bun:test"

import { trustedClientIp } from "./client-ip"

test("client IP trusts only production Vercel x-real-ip", () => {
  const headers = new Headers({
    "x-real-ip": "192.0.2.1",
    "x-forwarded-for": "198.51.100.1",
  })
  expect(trustedClientIp(headers, "production", "1")).toBe("192.0.2.1")
  for (const vercel of ["", "0", "true"])
    expect(trustedClientIp(headers, "production", vercel)).toBeNull()
  for (const mode of ["development", "test"] as const)
    expect(trustedClientIp(headers, mode, "1")).toBe("127.0.0.1")
  for (const mode of ["", "staging", "unknown"])
    expect(trustedClientIp(headers, mode, "1")).toBeNull()
  headers.delete("x-real-ip")
  expect(trustedClientIp(headers, "production", "1")).toBeNull()
  for (const invalid of [
    "",
    "garbage",
    "192.0.2.1, 192.0.2.2",
    "192.0.2.1:80",
    "[::1]",
    "2001:db8::1%eth0",
    "192.0.2.01",
  ])
    expect(
      trustedClientIp(new Headers({ "x-real-ip": invalid }), "production", "1"),
    ).toBeNull()
})

test("client IP canonicalizes IPv6 and both mapped IPv4 forms", () => {
  for (const ip of [
    "::ffff:192.0.2.1",
    "::ffff:c000:201",
    "0:0:0:0:0:FFFF:C000:0201",
  ])
    expect(
      trustedClientIp(new Headers({ "x-real-ip": ip }), "production", "1"),
    ).toBe("192.0.2.1")
  expect(
    trustedClientIp(
      new Headers({ "x-real-ip": "2001:DB8:0:0:0:0:0:1" }),
      "production",
      "1",
    ),
  ).toBe("2001:db8::1")
})

test("missing environment markers fail closed", () => {
  const mode = process.env.NODE_ENV
  const vercel = process.env.VERCEL
  try {
    Reflect.deleteProperty(process.env, "NODE_ENV")
    delete process.env.VERCEL
    const headers = new Headers({ "x-real-ip": "192.0.2.1" })
    expect(trustedClientIp(headers)).toBeNull()
    Reflect.set(process.env, "NODE_ENV", "production")
    expect(trustedClientIp(headers)).toBeNull()
  } finally {
    if (mode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV")
    else Reflect.set(process.env, "NODE_ENV", mode)
    if (vercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = vercel
  }
})
