import { expect, test } from "bun:test"
import { assign, createActor, fromCallback, fromPromise } from "xstate"

import { connectionMachine } from "./machine"

test("a failed receiver signal returns the share connection to idle", async () => {
  let closed = false
  const peerConnection = {
    close: () => {
      closed = true
    },
  } as RTCPeerConnection
  const machine = connectionMachine.provide({
    actions: {
      createPeerConnection: assign({ peerConnection: () => peerConnection }),
    },
    actors: {
      sendResponse: fromPromise(async () => undefined) as never,
      connectReceiverPeerMachine: fromCallback(() => () => undefined) as never,
    },
  })
  const actor = createActor(machine, {
    input: {
      currentUser: {} as never,
      deviceId: "device",
      remoteUserId: "person",
      supabase: {} as never,
      trpcClient: {} as never,
    },
  }).start()

  actor.send({ type: "connection-request-received", request: {} as never })
  actor.send({ type: "accept" })
  await Promise.resolve()
  await Promise.resolve()
  expect(actor.getSnapshot().value).toBe("connecting with caller")

  actor.send({ type: "peer-connection.failed", error: { type: "unknown" } })
  expect(actor.getSnapshot().value).toBe("idle")
  expect(actor.getSnapshot().context.peerConnection).toBeUndefined()
  expect(closed).toBe(true)
  actor.stop()
})

test("a failed caller signal returns the share connection to idle", async () => {
  let closed = false
  const peerConnection = {
    close: () => {
      closed = true
    },
  } as RTCPeerConnection
  const machine = connectionMachine.provide({
    actions: {
      createPeerConnection: assign({ peerConnection: () => peerConnection }),
    },
    actors: {
      sendRequest: fromPromise(async () => ({ id: "request" })) as never,
      listenToFileRequestResponseTable: fromCallback(({ sendBack }) => {
        sendBack({
          type: "file-request-response",
          response: {
            accepted: true,
            accepted_by_device_id: "receiver-device",
          },
        })
      }) as never,
      connectCallerPeerMachine: fromCallback(() => () => undefined) as never,
    },
  })
  const actor = createActor(machine, {
    input: {
      currentUser: {} as never,
      deviceId: "device",
      remoteUserId: "person",
      supabase: {} as never,
      trpcClient: {} as never,
    },
  }).start()

  actor.send({ type: "send-files", files: [] })
  await Promise.resolve()
  await Promise.resolve()
  expect(actor.getSnapshot().value).toBe("connecting")

  actor.send({ type: "peer-connection.failed", error: { type: "unknown" } })
  expect(actor.getSnapshot().value).toBe("idle")
  expect(actor.getSnapshot().context.peerConnection).toBeUndefined()
  expect(closed).toBe(true)
  actor.stop()
})
