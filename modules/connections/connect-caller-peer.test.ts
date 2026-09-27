import { expect, test } from "bun:test"
import { createActor, createMachine, fromCallback, fromPromise } from "xstate"

import { connectCallerPeerMachine } from "./connect-caller-peer"

test("starts caller negotiation only after its private signal channel is ready", async () => {
  let peerNegotiations = 0

  const machine = connectCallerPeerMachine.provide({
    actors: {
      cleanUpSignalingRows: fromPromise(() => Promise.resolve()),
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
      trpcClient: {} as never,
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

test("failed signal delivery reaches the peer failure event", async () => {
  const machine = connectCallerPeerMachine.provide({
    actors: {
      cleanUpSignalingRows: fromPromise(() => Promise.resolve()),
      connectPeer: fromCallback(({ sendBack }) => {
        sendBack({
          type: "peer-connection.description",
          description: { type: "offer", sdp: "v=0\r\n" },
        })
      }),
      webRtcSignals: fromCallback(({ sendBack }) => {
        sendBack({ type: "signals.ready" })
      }),
    },
  })
  const parent = createMachine({
    initial: "connecting",
    states: {
      connecting: {
        invoke: {
          src: machine,
          input: {
            currentUser: {} as never,
            deviceId: "caller-device",
            peerConnection: {} as RTCPeerConnection,
            remoteUserId: "receiver-person",
            supabase: {} as never,
            trpcClient: {
              signals: {
                send: { mutate: () => Promise.reject(new Error("offline")) },
              },
            } as never,
          },
        },
        on: { "peer-connection.failed": "failed" },
      },
      failed: {},
    },
  })
  const actor = createActor(parent).start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(actor.getSnapshot().value).toBe("failed")
  actor.stop()
})
