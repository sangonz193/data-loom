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
      remoteDeviceId: "receiver-device",
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

test("failed signal delivery reaches the peer failure event and stops negotiation", async () => {
  let stopped = false
  const machine = connectCallerPeerMachine.provide({
    actors: {
      cleanUpSignalingRows: fromPromise(() => Promise.resolve()),
      connectPeer: fromCallback(({ sendBack }) => {
        sendBack({
          type: "peer-connection.description",
          description: { type: "offer", sdp: "v=0\r\n" },
        })
        return () => {
          stopped = true
        }
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
            remoteDeviceId: "receiver-device",
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
  expect(stopped).toBe(true)
  actor.stop()
})

test("caller addresses offers and queued and subsequent ICE to its selected device", async () => {
  const sent: unknown[] = []
  const received: unknown[] = []
  let stopped = false
  const machine = connectCallerPeerMachine.provide({
    actors: {
      cleanUpSignalingRows: fromPromise(() => Promise.resolve()),
      connectPeer: fromCallback(({ receive }) => {
        receive((event) => received.push(event))
        return () => {
          stopped = true
        }
      }),
      webRtcSignals: fromCallback(() => {}),
    },
  })
  const actor = createActor(machine, {
    input: {
      currentUser: {} as never,
      deviceId: "caller-device",
      remoteUserId: "receiver-person",
      remoteDeviceId: "receiver-device",
      peerConnection: {} as never,
      supabase: {} as never,
      trpcClient: {
        signals: {
          send: {
            mutate: async (input: unknown) => {
              sent.push(input)
            },
          },
        },
      } as never,
    },
  }).start()
  expect(sent).toEqual([])
  actor.send({ type: "signals.ready" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const candidate = {
    candidate: "queued",
    toJSON: () => ({ candidate: "queued" }),
  } as RTCIceCandidate
  actor.send({ type: "peer-connection.ice-candidate", candidate })
  actor.send({
    type: "peer-connection.description",
    description: { type: "offer", sdp: "offer" },
  })
  actor.send({
    type: "signals.answer",
    answer: { type: "answer", sdp: "answer" },
  })
  actor.send({
    type: "peer-connection.ice-candidate",
    candidate: {
      candidate: "next",
      toJSON: () => ({ candidate: "next" }),
    } as RTCIceCandidate,
  })
  expect(sent).toEqual([
    {
      deviceId: "caller-device",
      toDeviceId: "receiver-device",
      payload: { type: "offer", sdp: "offer" },
    },
    {
      deviceId: "caller-device",
      toDeviceId: "receiver-device",
      payload: { candidate: "queued" },
    },
    {
      deviceId: "caller-device",
      toDeviceId: "receiver-device",
      payload: { candidate: "next" },
    },
  ])
  expect(received).toEqual([
    {
      type: "description-received",
      description: { type: "answer", sdp: "answer" },
    },
  ])
  expect(stopped).toBe(false)
  actor.send({ type: "peer-connection.successful" })
  expect(actor.getSnapshot().status).toBe("done")
  expect(stopped).toBe(true)
  actor.stop()
})
