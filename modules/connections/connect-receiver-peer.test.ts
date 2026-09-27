import { expect, test } from "bun:test"
import { createActor, createMachine, fromCallback, fromPromise } from "xstate"

import { connectReceiverPeerMachine } from "./connect-receiver-peer"

for (const pinned of [false, true]) {
  test(`receiver ${pinned ? "retains the selected" : "pins the offering"} device before answering`, async () => {
    const remoteUserId = crypto.randomUUID()
    const remoteDeviceId = crypto.randomUUID()
    const deviceId = crypto.randomUUID()
    const sent: unknown[] = []
    let receiveSignal!: (payload: unknown) => void
    let subscribed!: (status: string) => void
    let ready = false
    const candidate = { candidate: "ice", toJSON: () => ({ candidate: "ice" }) }
    const channel = {
      on: (
        _type: string,
        _filter: unknown,
        callback: (event: { payload: unknown }) => void,
      ) => {
        receiveSignal = (payload) => callback({ payload })
        return channel
      },
      subscribe: (callback: (status: string) => void) => {
        subscribed = callback
        return channel
      },
    }
    const machine = connectReceiverPeerMachine.provide({
      actors: {
        cleanUpSignalingRows: fromPromise(() => Promise.resolve()),
        connectPeer: fromCallback(({ receive, sendBack }) => {
          receive((event) => {
            if (event.type !== "description-received") return
            expect(
              actor.getSnapshot().children.receiver!.getSnapshot().context
                .remoteDeviceId,
            ).toBe(remoteDeviceId)
            sendBack({
              type: "peer-connection.description",
              description: { type: "answer", sdp: "answer" },
            })
            sendBack({ type: "peer-connection.ice-candidate", candidate })
          })
        }),
      },
    })
    const parent = createMachine({
      invoke: {
        id: "receiver",
        src: machine,
        input: {
          currentUser: {} as never,
          peerConnection: {} as never,
          remoteUserId,
          deviceId,
          remoteDeviceId: pinned ? remoteDeviceId : undefined,
          supabase: {
            channel: () => channel,
            removeChannel: () => {},
          } as never,
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
      },
      on: {
        "signals.ready": {
          actions: () => {
            ready = true
          },
        },
      },
    })
    const actor = createActor(parent).start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ready).toBe(false)
    subscribed("SUBSCRIBED")
    expect(ready).toBe(true)
    const envelope = {
      fromPersonId: remoteUserId,
      fromDeviceId: remoteDeviceId,
    }
    receiveSignal({ ...envelope, payload: { type: "answer", sdp: "early" } })
    expect(sent).toEqual([])
    receiveSignal({ ...envelope, payload: { type: "offer", sdp: "offer" } })
    expect(sent).toEqual([
      {
        deviceId,
        toDeviceId: remoteDeviceId,
        payload: { type: "answer", sdp: "answer" },
      },
      { deviceId, toDeviceId: remoteDeviceId, payload: { candidate: "ice" } },
    ])
    receiveSignal({
      ...envelope,
      fromDeviceId: crypto.randomUUID(),
      payload: { type: "offer", sdp: "sibling" },
    })
    expect(sent).toHaveLength(2)
    actor.stop()
  })
}
