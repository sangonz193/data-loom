import { expect, test } from "bun:test"
import { createActor, fromCallback, fromPromise } from "xstate"

import { connectCallerPeerMachine } from "./connect-caller-peer"

test("starts caller negotiation only after its private signal channel is ready", async () => {
  let peerNegotiations = 0

  const machine = connectCallerPeerMachine.provide({
    actors: {
      cleanUpSignalingRows: fromPromise(async () => undefined),
      connectPeer: fromCallback(() => {
        peerNegotiations += 1
        return () => undefined
      }),
      webRtcSignals: fromCallback(() => () => undefined),
    },
  })
  const actor = createActor(machine, {
    input: {
      currentUser: {} as never,
      deviceId: "caller-device",
      peerConnection: {} as RTCPeerConnection,
      remoteUserId: "receiver-person",
      supabase: {} as never,
    },
  })

  actor.start()

  expect(peerNegotiations).toBe(0)

  actor.send({ type: "signals.ready" })
  await Promise.resolve()
  await Promise.resolve()

  expect(peerNegotiations).toBe(1)

  actor.stop()
})
