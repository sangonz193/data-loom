import { expect, test } from "bun:test"

import { sendSignalChannelReady } from "./web-rtc-signals"

test("does not notify the pairing flow before the signal channel subscribes", () => {
  const events: string[] = []
  const sendBack = (event: { type: string }) => events.push(event.type)

  sendSignalChannelReady("CHANNEL_JOINED", sendBack)

  expect(events).toEqual([])
})

test("notifies the pairing flow after the signal channel subscribes", () => {
  const events: string[] = []
  const sendBack = (event: { type: string }) => events.push(event.type)

  sendSignalChannelReady("SUBSCRIBED", sendBack)

  expect(events).toEqual(["signals.ready"])
})
