import { expect, test } from "bun:test"
import { assign, createActor, fromCallback, fromPromise } from "xstate"

import { connectionMachine } from "./machine"

const input = {
  currentUser: {} as never,
  remoteUserId: "remote-person",
  deviceId: "local-device",
  supabase: {} as never,
  trpcClient: {} as never,
}

for (const acceptedDeviceId of [null, "accepted-device"]) {
  test(`sender ${acceptedDeviceId ? "pins the accepting device" : "rejects acceptance without a device"}`, async () => {
    let callerInput: unknown
    const machine = connectionMachine.provide({
      actions: { createPeerConnection: () => {} },
      actors: {
        sendRequest: fromPromise(async () => ({ id: "request" })) as never,
        listenToFileRequestResponseTable: fromCallback(() => {}),
        connectCallerPeerMachine: fromCallback(({ input }) => {
          callerInput = input
        }) as never,
      },
    })
    const actor = createActor(machine, { input }).start()
    actor.send({ type: "send-files", files: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    actor.send({
      type: "file-request-response",
      response: {
        created_at: new Date().toISOString(),
        request_id: "request",
        accepted: true,
        accepted_by_device_id: acceptedDeviceId,
      },
    })
    if (acceptedDeviceId) {
      expect(callerInput).toMatchObject({
        remoteDeviceId: acceptedDeviceId,
        deviceId: input.deviceId,
      })
      expect(actor.getSnapshot().context.remoteDeviceId).toBe(acceptedDeviceId)
      actor.send({ type: "peer-connection.failed", error: { type: "unknown" } })
      expect(actor.getSnapshot().context.remoteDeviceId).toBeUndefined()
    } else {
      expect(callerInput).toBeUndefined()
      expect(actor.getSnapshot().value).toBe("idle")
    }
    actor.stop()
  })
}

test("receiver pins the requesting device before acceptance and clears it with the transfer", async () => {
  let receiverInput: unknown
  let acceptedPin: unknown
  const machine = connectionMachine.provide({
    actions: {
      createPeerConnection: assign({
        peerConnection: () => ({ close: () => {} }) as RTCPeerConnection,
      }),
    },
    actors: {
      connectReceiverPeerMachine: fromCallback(({ input, sendBack }) => {
        receiverInput = input
        sendBack({ type: "signals.ready" })
      }) as never,
    },
  })
  const actor = createActor(machine, {
    input: {
      ...input,
      trpcClient: {
        shares: {
          respond: {
            mutate: async () => {
              acceptedPin = actor.getSnapshot().context.remoteDeviceId
            },
          },
        },
      } as never,
    },
  }).start()
  actor.send({
    type: "connection-request-received",
    request: { id: "request", from_device_id: "sending-device" } as never,
  })
  expect(actor.getSnapshot().context.remoteDeviceId).toBe("sending-device")
  actor.send({ type: "accept" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(acceptedPin).toBe("sending-device")
  expect(receiverInput).toMatchObject({
    remoteDeviceId: "sending-device",
    deviceId: input.deviceId,
  })
  actor.send({ type: "peer-connection.failed", error: { type: "unknown" } })
  expect(actor.getSnapshot().context.remoteDeviceId).toBeUndefined()
  actor.stop()
})
