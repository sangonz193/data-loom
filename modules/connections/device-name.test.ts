import { expect, test } from "bun:test"

import { DEVICE_NAME_MAX_LENGTH, deviceNameFromUserAgent } from "./device-name"

test.each([
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
    "Chrome on Windows",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36",
    "Chrome on macOS",
  ],
  [
    "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36",
    "Chrome on Linux",
  ],
  [
    "Mozilla/5.0 (X11; CrOS x86_64) Chrome/120.0.0.0 Safari/537.36",
    "Chrome on ChromeOS",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Chrome on Android",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    "Safari on iOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) CriOS/120.0.0.0 Mobile Safari/604.1",
    "Chrome on iOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) FxiOS/120.0 Mobile Safari/604.1",
    "Firefox on iOS",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0",
    "Edge on Windows",
  ],
  [
    "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Firefox/120.0",
    "Firefox on Linux",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
    "Safari on macOS",
  ],
  ["", "Browser"],
])("names %s", (userAgent, expected) => {
  const name = deviceNameFromUserAgent(userAgent)
  expect(name).toBe(expected)
  expect(name.length).toBeLessThanOrEqual(DEVICE_NAME_MAX_LENGTH)
  expect(name).not.toMatch(/\d/)
})

test("iPad desktop mode uses its reported macOS platform", () => {
  expect(
    deviceNameFromUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    ),
  ).toBe("Safari on macOS")
})
