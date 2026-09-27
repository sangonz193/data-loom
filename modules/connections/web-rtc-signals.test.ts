import { expect, test } from "bun:test"

import {
  createSignalRouter,
  type WebRtcSignalsOutputEvent,
  sendSignalChannelReady,
} from "./web-rtc-signals"

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

const remoteUserId = crypto.randomUUID()
const remoteDeviceId = crypto.randomUUID()
const siblingDeviceId = crypto.randomUUID()
const offer = { type: "offer", sdp: "offer" }
const answer = { type: "answer", sdp: "answer" }
const candidate = { candidate: "candidate", sdpMid: "0" }

for (const pinned of [false, true]) {
  test(`routes only validated signals from the expected person and ${pinned ? "selected" : "first offering"} device`, () => {
    const events: WebRtcSignalsOutputEvent[] = []
    const route = createSignalRouter(
      { remoteUserId, remoteDeviceId: pinned ? remoteDeviceId : undefined },
      (event) => events.push(event),
    )
    const envelope = {
      fromPersonId: remoteUserId,
      fromDeviceId: remoteDeviceId,
    }
    for (const malformed of [
      null,
      [],
      {},
      { ...envelope, payload: { type: "offer" } },
      { ...envelope, fromDeviceId: "invalid", payload: offer },
      { fromPersonId: remoteUserId, payload: offer },
      { ...envelope, payload: { candidate: 1 } },
      {
        ...envelope,
        payload: { type: "offer", sdp: "offer", fromDeviceId: siblingDeviceId },
      },
    ])
      route(malformed)
    route({ ...envelope, fromPersonId: crypto.randomUUID(), payload: offer })
    if (!pinned) {
      route({ ...envelope, payload: answer })
      route({ ...envelope, payload: candidate })
    } else {
      route({ ...envelope, fromDeviceId: siblingDeviceId, payload: offer })
    }
    expect(events).toEqual([])
    route({ ...envelope, payload: offer })
    for (const payload of [offer, answer, candidate])
      route({ ...envelope, fromDeviceId: siblingDeviceId, payload })
    route({ ...envelope, payload: answer })
    route({ ...envelope, payload: candidate })
    expect(events as unknown[]).toEqual([
      { type: "signals.offer", offer, fromDeviceId: remoteDeviceId },
      { type: "signals.answer", answer },
      { type: "signals.ice-candidate", iceCandidate: candidate },
    ])
  })
}
