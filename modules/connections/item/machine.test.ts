import { expect, mock, test } from "bun:test"
import {
  assign,
  createActor,
  fromCallback,
  fromPromise,
  type SnapshotFrom,
} from "xstate"

import type { Tables } from "@/supabase/types"

import { connectCallerPeerMachine } from "../connect-caller-peer"
import { connectReceiverPeerMachine } from "../connect-receiver-peer"
import { connectionMachine } from "./machine"

const input = {
  currentUser: {} as never,
  remoteUserId: "person-b",
  deviceId: "device-a",
  supabase: {} as never,
  trpcClient: {} as never,
}

const request = {
  id: "request-a",
  payload: { files: [] },
} as unknown as Tables<"share_requests">

async function settle() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

function expectActiveState(
  actor: { getSnapshot: () => SnapshotFrom<typeof connectionMachine> },
  value: SnapshotFrom<typeof connectionMachine>["value"],
) {
  expect(actor.getSnapshot().status).toBe("active")
  expect(actor.getSnapshot().value).toEqual(value)
}

for (const accepted of [true, false]) {
  for (const responseTiming of [
    "before failure",
    "before Retry",
    "after Retry",
  ]) {
    test(`lost request acknowledgment recovers ${accepted ? "acceptance" : "decline"} ${responseTiming}`, async () => {
      const requests = new Map<string, typeof request>()
      const attempts: unknown[] = []
      let response: Tables<"share_request_responses"> | null = null
      let onInsert: (payload: { new: typeof response }) => void = () => {}
      let onStatus: (status: string) => void = () => {}
      let removed = false
      const channel = {
        on: (
          _event: string,
          filter: { filter: string },
          callback: typeof onInsert,
        ) => {
          expect(filter.filter).toBe(`request_id=eq.${[...requests.keys()][0]}`)
          onInsert = callback
          return channel
        },
        subscribe: (callback: typeof onStatus) => {
          onStatus = callback
          return channel
        },
      }
      const query = {
        select: () => query,
        eq: (_column: string, id: string) => {
          expect(id).toBe([...requests.keys()][0]!)
          return query
        },
        abortSignal: () => query,
        maybeSingle: async () => ({ data: response, error: null }),
      }
      const machine = connectionMachine.provide({
        actions: { createPeerConnection: () => undefined },
        actors: {
          connectCallerPeerMachine: fromCallback(
            () => () => undefined,
          ) as unknown as typeof connectCallerPeerMachine,
        },
      })
      const actor = createActor(machine, {
        input: {
          ...input,
          supabase: {
            channel: () => channel,
            from: () => query,
            removeChannel: () => {
              removed = true
            },
          } as never,
          trpcClient: {
            shares: {
              request: {
                mutate: async (payload: { requestId: string }) => {
                  attempts.push(payload)
                  if (!requests.has(payload.requestId)) {
                    requests.set(payload.requestId, {
                      ...request,
                      id: payload.requestId,
                    })
                  }
                  if (attempts.length === 1) {
                    if (responseTiming === "before failure") {
                      response = {
                        request_id: payload.requestId,
                        accepted,
                        accepted_by_device_id: accepted ? "device-b" : null,
                        created_at: new Date().toISOString(),
                      }
                    }
                    throw new Error("HTTP acknowledgment lost")
                  }
                  return requests.get(payload.requestId)!
                },
              },
            },
          } as never,
        },
      }).start()

      actor.send({ type: "send-files", files: [new File(["data"], "a.txt")] })
      await settle()
      expectActiveState(actor, "request failed")
      const savedResponse = {
        request_id: [...requests.keys()][0]!,
        accepted,
        accepted_by_device_id: accepted ? "device-b" : null,
        created_at: new Date().toISOString(),
      }
      if (responseTiming === "before Retry") response = savedResponse
      actor.send({ type: "retry" })
      await settle()
      expectActiveState(actor, "waiting for response")
      onStatus("SUBSCRIBED")
      await settle()
      if (responseTiming === "after Retry") {
        expectActiveState(actor, "waiting for response")
        onInsert({ new: savedResponse })
      }
      expectActiveState(actor, accepted ? "connecting" : "idle")
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toEqual(attempts[0])
      expect(requests.size).toBe(1)
      expect(removed).toBe(true)
      actor.stop()
    })
  }
}

test("response listener failure allows retrying the same request", async () => {
  let subscriptions = 0
  const requestIds: string[] = []
  const machine = connectionMachine.provide({
    actors: {
      listenToFileRequestResponseTable: fromCallback(({ sendBack }) => {
        if (++subscriptions === 1)
          sendBack({ type: "file-request-response.failed" })
      }),
    },
  })
  const actor = createActor(machine, {
    input: {
      ...input,
      trpcClient: {
        shares: {
          request: {
            mutate: async ({ requestId }: { requestId: string }) => {
              requestIds.push(requestId)
              return { ...request, id: requestId }
            },
          },
        },
      } as never,
    },
  }).start()
  actor.send({ type: "send-files", files: [] })
  await settle()
  expectActiveState(actor, "request failed")
  actor.send({ type: "retry" })
  await settle()
  expectActiveState(actor, "waiting for response")
  expect(requestIds).toHaveLength(2)
  expect(requestIds[1]).toBe(requestIds[0]!)
  actor.stop()
})

for (const [action, failedState, pendingState] of [
  [
    "accept",
    { "receiving connection": "acceptance failed" },
    { "receiving connection": "accepting request" },
  ],
  ["decline", "decline failed", "declining request"],
] as const) {
  test(`${action} rejection is handled and retry sends the same response`, async () => {
    const responses: boolean[] = []
    const machine = connectionMachine.provide({
      actions: { createPeerConnection: () => undefined },
      actors: {
        connectReceiverPeerMachine: fromCallback(({ sendBack }) => {
          sendBack({ type: "signals.ready" })
        }) as unknown as typeof connectReceiverPeerMachine,
      },
    })
    const actor = createActor(machine, {
      input: {
        ...input,
        trpcClient: {
          shares: {
            respond: {
              mutate: async ({ accepted }: { accepted: boolean }) => {
                responses.push(accepted)
                if (responses.length === 1) throw new Error("Request expired")
              },
            },
          },
        } as never,
      },
    }).start()

    actor.send({ type: "connection-request-received", request })
    actor.send({ type: action })
    expectActiveState(actor, pendingState)
    await settle()
    expectActiveState(actor, failedState)
    actor.send({ type: "retry" })
    await settle()
    expectActiveState(
      actor,
      action === "accept" ?
        { "receiving connection": "connecting with caller" }
      : "idle",
    )
    expect(responses).toEqual([action === "accept", action === "accept"])
    actor.stop()
  })
}

for (const action of ["send-files", "accept", "decline"] as const) {
  test(`${action} failure can be dismissed without leaving a pending transfer`, async () => {
    let closedPeers = 0
    const machine = connectionMachine.provide({
      actions: {
        createPeerConnection: () => undefined,
        closePeerConnection: () => {
          closedPeers += 1
        },
      },
      actors: {
        connectReceiverPeerMachine: fromCallback(({ sendBack }) => {
          sendBack({ type: "signals.ready" })
        }) as never,
      },
    })
    const actor = createActor(machine, {
      input: {
        ...input,
        trpcClient: {
          shares: {
            request: {
              mutate: async () => {
                throw new Error("Unavailable")
              },
            },
            respond: {
              mutate: async () => {
                throw new Error("Unavailable")
              },
            },
          },
        } as never,
      },
    }).start()

    if (action === "send-files") {
      actor.send({ type: action, files: [new File(["data"], "a.txt")] })
    } else {
      actor.send({ type: "connection-request-received", request })
      actor.send({ type: action })
    }
    await settle()
    actor.send({ type: "dismiss-error" })
    expectActiveState(actor, "idle")
    expect(actor.getSnapshot().context.filesToSend).toBeUndefined()
    expect(actor.getSnapshot().context.request).toBeUndefined()
    expect(closedPeers).toBe(action === "accept" ? 1 : 0)
    actor.stop()
  })
}

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
      connectReceiverPeerMachine: fromCallback(({ sendBack }) => {
        sendBack({ type: "signals.ready" })
      }) as never,
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
  expectActiveState(actor, { "receiving connection": "connecting with caller" })

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

function createReceiverHarness() {
  const remotePersonId = "44444444-4444-4444-8444-444444444444"
  const remoteDeviceId = "55555555-5555-4555-8555-555555555555"
  const responses = [] as {
    input: { requestId: string; accepted: boolean; deviceId: string }
    acknowledgment: ReturnType<typeof Promise.withResolvers<void>>
  }[]
  const persisted = new Map<string, boolean>()
  const peerConnection = {
    remoteDescription: null as RTCSessionDescriptionInit | null,
    localDescription: { type: "answer", sdp: "answer" },
    setRemoteDescription: mock(async (offer: RTCSessionDescriptionInit) => {
      peerConnection.remoteDescription = offer
    }),
    setLocalDescription: mock(async () => {}),
    addEventListener: mock(() => {}),
    removeEventListener: mock(() => {}),
    close: mock(() => {}),
  }
  let listening = false
  let onStatus: (status: string) => void = () => {}
  let onBroadcast: (event: { payload: unknown }) => void = () => {}
  const channel = {
    on: (_type: string, _filter: unknown, callback: typeof onBroadcast) => {
      onBroadcast = callback
      return channel
    },
    subscribe: (callback: typeof onStatus) => {
      listening = true
      onStatus = callback
      return channel
    },
  }
  const supabase = {
    channel: mock(() => channel),
    removeChannel: mock(() => {
      listening = false
    }),
  }
  const sendSignal = mock<(payload: unknown) => Promise<void>>(async () => {})
  const transfer = Promise.withResolvers<void>()
  const machine = connectionMachine.provide({
    actions: {
      createPeerConnection: assign({
        peerConnection: () => peerConnection as unknown as RTCPeerConnection,
      }),
    },
    actors: {
      receiveFile: fromPromise(() => transfer.promise) as never,
    },
  })
  const actor = createActor(machine, {
    input: {
      ...input,
      remoteUserId: remotePersonId,
      supabase: supabase as never,
      trpcClient: {
        shares: {
          respond: {
            mutate: (input: (typeof responses)[number]["input"]) => {
              expect(listening).toBe(true)
              persisted.set(input.requestId, input.accepted)
              const acknowledgment = Promise.withResolvers<void>()
              responses.push({ input, acknowledgment })
              return acknowledgment.promise
            },
          },
        },
        signals: { send: { mutate: sendSignal } },
      } as never,
    },
  }).start()
  actor.send({
    type: "connection-request-received",
    request: {
      ...request,
      from_device_id: remoteDeviceId,
      payload: { files: [{ name: "a.txt", size: 4, mimeType: "text/plain" }] },
    },
  })
  actor.send({ type: "accept" })

  return {
    actor,
    remoteDeviceId,
    peerConnection,
    responses,
    persisted,
    supabase,
    sendSignal,
    transfer,
    ready: (status = "SUBSCRIBED") => onStatus(status),
    offer: () => {
      if (listening)
        onBroadcast({
          payload: {
            fromPersonId: remotePersonId,
            fromDeviceId: remoteDeviceId,
            payload: { type: "offer", sdp: "one-shot offer" },
          },
        })
    },
    dataChannel: () => {
      const channel = { label: "file:a.txt", close: mock(() => {}) }
      actor.send({
        type: "peer.datachannel",
        event: { channel } as unknown as RTCDataChannelEvent,
      })
      return channel
    },
  }
}

test("acceptance waits for receiver subscription readiness", async () => {
  const harness = createReceiverHarness()
  try {
    await settle()
    expectActiveState(harness.actor, {
      "receiving connection": "waiting for signals",
    })
    expect(harness.responses).toHaveLength(0)
    harness.ready()
    expectActiveState(harness.actor, {
      "receiving connection": "accepting request",
    })
    expect(harness.responses).toHaveLength(1)
    harness.ready()
    expect(harness.responses).toHaveLength(1)
  } finally {
    harness.actor.stop()
  }
  await settle()
  expect(harness.supabase.removeChannel).toHaveBeenCalledTimes(1)
})

for (const offerTiming of ["pending", "failed", "retrying"] as const) {
  test(`committed acceptance retains its single offer while ${offerTiming} through retry`, async () => {
    const harness = createReceiverHarness()
    const { actor, responses, peerConnection, supabase } = harness
    try {
      harness.ready()
      const receiver = actor.getSnapshot().children.connectReceiverPeerMachine
      expect(harness.persisted.get(request.id)).toBe(true)
      if (offerTiming === "pending") harness.offer()
      await settle()
      responses[0]!.acknowledgment.reject(new Error("HTTP acknowledgment lost"))
      await settle()
      expectActiveState(actor, { "receiving connection": "acceptance failed" })
      if (offerTiming === "failed") harness.offer()
      await settle()
      actor.send({ type: "retry" })
      expectActiveState(actor, { "receiving connection": "accepting request" })
      if (offerTiming === "retrying") harness.offer()
      await settle()
      expect(responses).toHaveLength(2)
      expect(responses[1]!.input).toEqual(responses[0]!.input)
      expect(harness.persisted.size).toBe(1)
      expect(actor.getSnapshot().children.connectReceiverPeerMachine).toBe(
        receiver!,
      )
      expect(supabase.channel).toHaveBeenCalledTimes(1)
      expect(supabase.removeChannel).not.toHaveBeenCalled()
      expect(peerConnection.setRemoteDescription).toHaveBeenCalledTimes(1)
      expect(peerConnection.remoteDescription).toEqual({
        type: "offer",
        sdp: "one-shot offer",
      })
      expect(harness.sendSignal).toHaveBeenCalledWith({
        deviceId: input.deviceId,
        toDeviceId: harness.remoteDeviceId,
        payload: { type: "answer", sdp: "answer" },
      })
      responses[1]!.acknowledgment.resolve()
      await settle()
      expectActiveState(actor, {
        "receiving connection": "connecting with caller",
      })
      expect(actor.getSnapshot().children.connectReceiverPeerMachine).toBe(
        receiver!,
      )
      const channel = harness.dataChannel()
      expect(actor.getSnapshot().matches("receiving files")).toBe(true)
      await settle()
      expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
      expect(peerConnection.removeEventListener.mock.calls.length).toBe(
        peerConnection.addEventListener.mock.calls.length,
      )
      harness.transfer.resolve()
      await settle()
      expectActiveState(actor, "idle")
      expect(channel.close).toHaveBeenCalledTimes(1)
      expect(peerConnection.close).toHaveBeenCalledTimes(1)
    } finally {
      actor.stop()
    }
  })
}

for (const channelTiming of ["pending", "failed", "retrying"] as const) {
  test(`receives the file channel while acceptance is ${channelTiming} and ignores late HTTP completion`, async () => {
    const harness = createReceiverHarness()
    const { actor, responses } = harness
    try {
      harness.ready()
      harness.offer()
      await settle()
      if (channelTiming !== "pending") {
        responses[0]!.acknowledgment.reject(
          new Error("HTTP acknowledgment lost"),
        )
        await settle()
      }
      if (channelTiming === "retrying") actor.send({ type: "retry" })
      harness.dataChannel()
      expect(actor.getSnapshot().matches("receiving files")).toBe(true)
      await settle()
      expect(harness.supabase.removeChannel).toHaveBeenCalledTimes(1)
      responses.at(-1)!.acknowledgment.reject(new Error("Late HTTP failure"))
      await settle()
      expect(actor.getSnapshot().matches("receiving files")).toBe(true)
    } finally {
      actor.stop()
    }
  })
}

test("dismissing failed acceptance stops the receiver and retry starts no extra listeners", async () => {
  const harness = createReceiverHarness()
  const { actor, responses, supabase, peerConnection } = harness
  try {
    harness.ready()
    responses[0]!.acknowledgment.reject(new Error("Unavailable"))
    await settle()
    actor.send({ type: "retry" })
    responses[1]!.acknowledgment.reject(new Error("Unavailable"))
    await settle()
    actor.send({ type: "dismiss-error" })
    await settle()
    expectActiveState(actor, "idle")
    expect(actor.getSnapshot().context.request).toBeUndefined()
    expect(actor.getSnapshot().context.peerConnection).toBeUndefined()
    expect(supabase.channel).toHaveBeenCalledTimes(1)
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
    expect(peerConnection.close).toHaveBeenCalledTimes(1)
    expect(peerConnection.removeEventListener.mock.calls.length).toBe(
      peerConnection.addEventListener.mock.calls.length,
    )
    harness.offer()
    harness.ready()
    actor.send({ type: "retry" })
    expectActiveState(actor, "idle")
    expect(peerConnection.setRemoteDescription).not.toHaveBeenCalled()
    expect(responses).toHaveLength(2)
    actor.send({ type: "connection-request-received", request })
    actor.send({ type: "accept" })
    expectActiveState(actor, { "receiving connection": "waiting for signals" })
    expect(supabase.channel).toHaveBeenCalledTimes(2)
  } finally {
    actor.stop()
  }
  await settle()
  expect(supabase.removeChannel).toHaveBeenCalledTimes(2)
})

for (const timing of ["pending", "failed", "retrying"] as const) {
  test(`answer signal rejection cleans up acceptance while ${timing}`, async () => {
    const harness = createReceiverHarness()
    const { actor, responses, peerConnection, supabase } = harness
    try {
      harness.ready()
      if (timing !== "pending") {
        responses[0]!.acknowledgment.reject(
          new Error("HTTP acknowledgment lost"),
        )
        await settle()
      }
      if (timing === "retrying") actor.send({ type: "retry" })
      harness.sendSignal.mockRejectedValueOnce(new Error("Signal failed"))
      harness.offer()
      await settle()
      expectActiveState(actor, "idle")
      expect(peerConnection.close).toHaveBeenCalledTimes(1)
      expect(supabase.removeChannel).toHaveBeenCalledTimes(1)
      responses.at(-1)!.acknowledgment.resolve()
      await settle()
      expectActiveState(actor, "idle")
    } finally {
      actor.stop()
    }
  })
}
