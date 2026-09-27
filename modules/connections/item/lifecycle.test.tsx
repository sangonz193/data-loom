import { TRPCClientError } from "@trpc/client"
import { expect, mock, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  assign,
  createActor,
  fromCallback,
  fromPromise,
  SimulatedClock,
} from "xstate"

import type { Tables } from "@/supabase/types"

import { connectionMachine } from "./machine"
import { RequestControls } from "./request-controls"

const request = {
  id: "request",
  from_person_id: "sender-person",
  to_person_id: "receiver-person",
  created_at: new Date().toISOString(),
  from_device_id: "sender-device",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  cancelled_at: null,
  payload: { files: [{ name: "a.txt", size: 4, mimeType: "text/plain" }] },
} satisfies Tables<"share_requests">

const response = {
  request_id: request.id,
  accepted: true,
  accepted_by_device_id: "local-device",
  created_at: new Date().toISOString(),
}

function apiError(code: string) {
  return TRPCClientError.from({
    error: { message: code, code: -32000, data: { code } },
  })
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function harness({
  callerConnected,
  transferDone,
}: {
  callerConnected?: Promise<void>
  transferDone?: Promise<void>
} = {}) {
  const clock = new SimulatedClock()
  const created = Promise.withResolvers<Tables<"share_requests">>()
  const answered = Promise.withResolvers<typeof response>()
  const cancelled = [] as ReturnType<typeof Promise.withResolvers<void>>[]
  const cancellationSignals: AbortSignal[] = []
  const requestSignals: AbortSignal[] = []
  const responseSignals: AbortSignal[] = []
  let requestId = ""
  let watchers = 0
  let watcherStops = 0
  let receiverStarts = 0
  let receiverStops = 0
  let callerStarts = 0
  let callerStops = 0
  let transferStops = 0
  const peer = { close: mock(() => {}) }
  const machine = connectionMachine.provide({
    actions: {
      createPeerConnection: assign({
        peerConnection: () => peer as unknown as RTCPeerConnection,
      }),
    },
    actors: {
      listenToFileRequestResponseTable: fromCallback(() => {
        watchers++
        return () => {
          watcherStops++
        }
      }),
      connectReceiverPeerMachine: fromCallback(({ sendBack }) => {
        receiverStarts++
        sendBack({ type: "signals.ready" })
        return () => {
          receiverStops++
        }
      }) as never,
      connectCallerPeerMachine: fromCallback(() => {
        callerStarts++
        return () => {
          callerStops++
        }
      }) as never,
      receiveFile: fromCallback(() => () => {
        transferStops++
      }) as never,
      sendFile: fromCallback(() => () => {
        transferStops++
      }) as never,
      ...(callerConnected && {
        connectCallerPeerMachine: fromPromise(() => callerConnected) as never,
      }),
      ...(transferDone && {
        sendFile: fromPromise(() => transferDone) as never,
        receiveFile: fromPromise(() => transferDone) as never,
      }),
    },
  })
  const actor = createActor(machine, {
    clock,
    input: {
      currentUser: {} as never,
      remoteUserId: "remote-person",
      deviceId: "local-device",
      supabase: {} as never,
      trpcClient: {
        shares: {
          request: {
            mutate: (
              input: { requestId: string },
              { signal }: { signal: AbortSignal },
            ) => {
              requestId = input.requestId
              requestSignals.push(signal)
              return created.promise
            },
          },
          respond: {
            mutate: (_input: unknown, { signal }: { signal: AbortSignal }) => {
              responseSignals.push(signal)
              return answered.promise
            },
          },
          cancel: {
            mutate: (
              input: { requestId: string },
              { signal }: { signal: AbortSignal },
            ) => {
              expect(input.requestId).toBe(requestId)
              expect(actor.getSnapshot().context.peerConnection).toBeUndefined()
              if (callerStarts) expect(peer.close).toHaveBeenCalledTimes(1)
              const result = Promise.withResolvers<void>()
              cancelled.push(result)
              cancellationSignals.push(signal)
              return result.promise
            },
          },
        },
      } as never,
    },
  }).start()
  return {
    actor,
    clock,
    created,
    answered,
    cancelled,
    peer,
    cancellationSignals,
    requestSignals,
    responseSignals,
    get watchers() {
      return watchers
    },
    get watcherStops() {
      return watcherStops
    },
    get receiverStarts() {
      return receiverStarts
    },
    get receiverStops() {
      return receiverStops
    },
    get callerStarts() {
      return callerStarts
    },
    get callerStops() {
      return callerStops
    },
    get transferStops() {
      return transferStops
    },
    get requestId() {
      return requestId
    },
    receive: () => actor.send({ type: "connection-request-received", request }),
    send: () =>
      actor.send({ type: "send-files", files: [new File(["data"], "a.txt")] }),
    controls: () =>
      renderToStaticMarkup(
        <RequestControls state={actor.getSnapshot()} send={actor.send} />,
      ),
  }
}

test("sender watcher failure clears when negotiation succeeds and stale controls cannot interrupt files or restart watching", async () => {
  const connected = Promise.withResolvers<void>()
  const transferred = Promise.withResolvers<void>()
  const h = harness({
    callerConnected: connected.promise,
    transferDone: transferred.promise,
  })
  try {
    h.send()
    h.created.resolve({ ...request, id: h.requestId })
    await settle()
    h.actor.send({
      type: "file-request-response",
      response: { ...response, request_id: h.requestId },
    })
    h.actor.send({ type: "file-request-response.failed" })
    expect(h.controls()).toContain("Could not check the file request.")
    connected.resolve()
    await settle()
    expect(h.actor.getSnapshot().matches("sending files")).toBe(true)
    expect(h.watcherStops).toBe(1)
    const transfer = h.actor.getSnapshot().context.sendFileRefs![0]!

    for (const phase of ["sending files", "files sent", "idle"] as const) {
      expect(h.actor.getSnapshot().matches(phase)).toBe(true)
      expect(h.actor.getSnapshot().context.watchFailed).toBe(false)
      h.actor.send({ type: "file-request-response.failed" })
      expect(h.actor.getSnapshot().can({ type: "retry-watcher" })).toBe(false)
      expect(h.actor.getSnapshot().can({ type: "dismiss-watcher" })).toBe(false)
      h.actor.send({ type: "retry-watcher" })
      h.actor.send({ type: "dismiss-watcher" })
      expect(h.actor.getSnapshot().matches(phase)).toBe(true)
      expect(h.controls()).not.toContain("Could not check the file request.")
      expect(h.controls()).not.toContain(">Retry<")
      expect(h.controls()).not.toContain(">Dismiss<")
      expect(h.watchers).toBe(1)
      expect(h.peer.close).not.toHaveBeenCalled()
      expect(h.actor.getSnapshot().context.sendFileRefs![0]).toBe(transfer)
      if (phase === "sending files") {
        expect(transfer.getSnapshot().status).toBe("active")
        transferred.resolve()
        await settle()
      } else if (phase === "files sent") {
        Object.assign(h.peer, { connectionState: "closed" })
        h.actor.send({
          type: "peer.connectionstatechange",
          event: new Event("connectionstatechange"),
        })
      }
    }
  } finally {
    h.actor.stop()
  }
})

for (const failureTiming of ["before transfer", "during transfer"] as const) {
  test(`receiver watcher failure ${failureTiming} can be retried and dismissed without losing transfer or cancellation monitoring`, () => {
    const h = harness()
    try {
      h.receive()
      h.actor.send({ type: "accept" })
      if (failureTiming === "before transfer")
        h.actor.send({ type: "file-request-response.failed" })
      const channel = { label: "file:a.txt", close: mock(() => {}) }
      h.actor.send({
        type: "peer.datachannel",
        event: { channel } as unknown as RTCDataChannelEvent,
      })
      if (failureTiming === "during transfer")
        h.actor.send({ type: "file-request-response.failed" })
      const transfer = h.actor.getSnapshot().context.receiveFileRefs![0]
      expect(h.controls()).toContain(">Retry<")
      expect(h.controls()).toContain(">Dismiss<")
      h.actor.send({ type: "retry-watcher" })
      expect(h.watchers).toBe(2)
      expect(h.watcherStops).toBe(1)
      expect(h.controls()).not.toContain("Could not check the file request.")
      h.actor.send({ type: "file-request-response.failed" })
      const watcher =
        h.actor.getSnapshot().children.listenToFileRequestResponseTable
      h.actor.send({ type: "dismiss-watcher" })
      expect(h.controls()).not.toContain("Could not check the file request.")
      h.actor.send({ type: "retry-watcher" })
      h.actor.send({ type: "dismiss-watcher" })
      expect(h.actor.getSnapshot().matches("receiving files")).toBe(true)
      expect(h.actor.getSnapshot().context.receiveFileRefs![0]).toBe(transfer)
      expect(h.actor.getSnapshot().context.peerConnection).toBe(
        h.peer as unknown as RTCPeerConnection,
      )
      expect(h.actor.getSnapshot().context.dataChannels).toEqual([
        channel as unknown as RTCDataChannel,
      ])
      expect(
        h.actor.getSnapshot().children.listenToFileRequestResponseTable,
      ).toBe(watcher)
      expect(h.watchers).toBe(2)
      expect(h.watcherStops).toBe(1)
      expect(h.transferStops).toBe(0)
      expect(h.peer.close).not.toHaveBeenCalled()
      expect(channel.close).not.toHaveBeenCalled()
      h.actor.send({ type: "file-request.cancelled", requestId: request.id })
      expect(h.actor.getSnapshot().value).toBe("idle")
      expect(h.watcherStops).toBe(2)
      expect(h.transferStops).toBe(1)
      expect(h.peer.close).toHaveBeenCalledTimes(1)
      expect(channel.close).toHaveBeenCalledTimes(1)
    } finally {
      h.actor.stop()
    }
  })
}

test("receiver completion clears watcher failure and ignores stale failure, Retry and Dismiss in idle", async () => {
  const transferred = Promise.withResolvers<void>()
  const h = harness({ transferDone: transferred.promise })
  try {
    h.receive()
    h.actor.send({ type: "accept" })
    const channel = { label: "file:a.txt", close: mock(() => {}) }
    h.actor.send({
      type: "peer.datachannel",
      event: { channel } as unknown as RTCDataChannelEvent,
    })
    h.actor.send({ type: "file-request-response.failed" })
    expect(h.controls()).toContain("Could not check the file request.")
    transferred.resolve()
    await settle()
    expect(h.actor.getSnapshot().value).toBe("idle")
    expect(h.actor.getSnapshot().context.watchFailed).toBe(false)
    expect(h.watcherStops).toBe(1)
    const completed = h.actor.getSnapshot().context.receiveFileRefs
    h.actor.send({ type: "file-request-response.failed" })
    expect(h.actor.getSnapshot().can({ type: "retry-watcher" })).toBe(false)
    expect(h.actor.getSnapshot().can({ type: "dismiss-watcher" })).toBe(false)
    h.actor.send({ type: "retry-watcher" })
    h.actor.send({ type: "dismiss-watcher" })
    expect(h.actor.getSnapshot().value).toBe("idle")
    expect(h.actor.getSnapshot().context.watchFailed).toBe(false)
    expect(h.actor.getSnapshot().context.receiveFileRefs).toBe(completed)
    expect(h.watchers).toBe(1)
    expect(h.controls()).toBe("")
    expect(h.peer.close).toHaveBeenCalledTimes(1)
    expect(channel.close).toHaveBeenCalledTimes(1)
  } finally {
    h.actor.stop()
  }
})

test("Cancel is hidden during creation and files, and closes the caller before the cancellation mutation", async () => {
  const h = harness()
  try {
    h.send()
    expect(h.controls()).not.toContain(">Cancel<")
    h.actor.send({ type: "cancel" })
    expect(h.cancelled).toHaveLength(0)
    h.created.resolve({ ...request, id: h.requestId })
    await settle()
    expect(h.controls()).toContain(">Cancel<")
    h.actor.send({
      type: "file-request-response",
      response: { ...response, request_id: h.requestId },
    })
    expect(h.callerStarts).toBe(1)
    expect(h.controls()).toContain(">Cancel<")
    h.actor.send({ type: "cancel" })
    expect(h.cancelled).toHaveLength(1)
    expect(h.callerStops).toBe(1)
    expect(h.watcherStops).toBe(1)
    expect(h.controls()).toContain("Cancelling request...")
    expect(h.controls()).toContain(">Dismiss<")
    h.actor.send({ type: "file-request-response", response })
    h.cancelled[0]!.resolve()
    await settle()
    expect(h.actor.getSnapshot().value).toBe("idle")
    expect(h.actor.getSnapshot().context.remoteDeviceId).toBeUndefined()
    expect(h.actor.getSnapshot().context.filesToSend).toBeUndefined()
  } finally {
    h.actor.stop()
  }

  const machine = connectionMachine.provide({
    actions: { createPeerConnection: () => {} },
    actors: {
      sendRequest: fromPromise(async () => request as Tables<"share_requests">),
      listenToFileRequestResponseTable: fromCallback(() => {}),
      connectCallerPeerMachine: fromPromise(async () => {}) as never,
      sendFile: fromCallback(() => {}) as never,
    },
  })
  const actor = createActor(machine, {
    input: {
      currentUser: {} as never,
      remoteUserId: "remote",
      deviceId: "local",
      supabase: {} as never,
      trpcClient: {} as never,
    },
  }).start()
  try {
    actor.send({ type: "send-files", files: [new File(["data"], "a.txt")] })
    await settle()
    actor.send({ type: "file-request-response", response })
    await settle()
    expect(actor.getSnapshot().matches("sending files")).toBe(true)
    expect(
      renderToStaticMarkup(
        <RequestControls state={actor.getSnapshot()} send={actor.send} />,
      ),
    ).not.toContain(">Cancel<")
  } finally {
    actor.stop()
  }
})

for (const result of ["NOT_FOUND", "failure", "timeout"] as const) {
  test(`failed-create Dismiss cancels the saved request and handles ${result}`, async () => {
    const h = harness()
    try {
      h.send()
      h.created.reject(new Error("HTTP acknowledgment lost"))
      await settle()
      expect(h.controls()).toContain(">Retry<")
      h.actor.send({ type: "dismiss-error" })
      expect(h.cancelled).toHaveLength(1)
      if (result === "timeout") {
        h.clock.increment(14_999)
        expect(h.actor.getSnapshot().value).toBe("cancelling request")
        h.clock.increment(1)
        expect(h.cancellationSignals[0]!.aborted).toBe(true)
      } else
        h.cancelled[0]!.reject(
          result === "NOT_FOUND" ? apiError(result) : new Error("Offline"),
        )
      await settle()
      if (result === "NOT_FOUND")
        expect(h.actor.getSnapshot().value).toBe("idle")
      else {
        expect(h.actor.getSnapshot().value).toBe("cancellation failed")
        expect(h.controls()).toContain(">Retry<")
        expect(h.controls()).toContain(">Dismiss<")
        h.actor.send({ type: "retry" })
        expect(h.cancelled).toHaveLength(2)
        h.cancelled[0]!.resolve()
        await settle()
        expect(h.actor.getSnapshot().value).toBe("cancelling request")
        h.actor.send({ type: "dismiss-error" })
        expect(h.cancellationSignals[1]!.aborted).toBe(true)
        h.cancelled[1]!.resolve()
        await settle()
        expect(h.actor.getSnapshot().value).toBe("idle")
      }
    } finally {
      h.actor.stop()
    }
  })
}

test("creation and response timeouts abort HTTP work without removing the acceptance listener", async () => {
  const sender = harness()
  sender.send()
  sender.clock.increment(15_000)
  expect(sender.actor.getSnapshot().value).toBe("request failed")
  expect(sender.requestSignals[0]!.aborted).toBe(true)
  sender.created.resolve(request)
  await settle()
  expect(sender.actor.getSnapshot().value).toBe("request failed")
  sender.actor.stop()

  const receiver = harness()
  try {
    receiver.receive()
    receiver.actor.send({ type: "accept" })
    receiver.clock.increment(15_000)
    expect(
      receiver.actor
        .getSnapshot()
        .matches({ "receiving connection": "acceptance failed" }),
    ).toBe(true)
    expect(receiver.responseSignals[0]!.aborted).toBe(true)
    expect(receiver.receiverStops).toBe(0)
    expect(receiver.watcherStops).toBe(0)
    receiver.actor.send({ type: "file-request-response", response })
    receiver.actor.send({ type: "file-request.expired", requestId: request.id })
    expect(receiver.actor.getSnapshot().matches("receiving connection")).toBe(
      true,
    )
    receiver.actor.send({ type: "retry" })
    expect(receiver.receiverStarts).toBe(1)
    receiver.answered.resolve(response)
    await settle()
    expect(
      receiver.actor
        .getSnapshot()
        .matches({ "receiving connection": "connecting with caller" }),
    ).toBe(true)
  } finally {
    receiver.actor.stop()
  }
})

for (const phase of [
  "prompt",
  "declining",
  "decline failed",
  "accepting",
  "acceptance failed",
  "connecting",
] as const) {
  for (const terminal of [
    "cancel",
    "sibling accept",
    "sibling decline",
  ] as const) {
    test(`${terminal} dismisses receiver in ${phase} and cleans late events`, async () => {
      const h = harness()
      try {
        h.receive()
        if (phase.startsWith("declin")) h.actor.send({ type: "decline" })
        if (["accepting", "acceptance failed", "connecting"].includes(phase))
          h.actor.send({ type: "accept" })
        if (phase.endsWith("failed"))
          h.answered.reject(new Error("Lost acknowledgment"))
        if (phase === "connecting") h.answered.resolve(response)
        await settle()
        expect(h.watcherStops).toBe(0)
        if (terminal === "cancel")
          h.actor.send({
            type: "file-request.cancelled",
            requestId: request.id,
          })
        else
          h.actor.send({
            type: "file-request-response",
            response: {
              ...response,
              accepted: terminal === "sibling accept",
              accepted_by_device_id:
                terminal === "sibling accept" ? "sibling-device" : null,
            },
          })
        expect(h.actor.getSnapshot().value).toBe("idle")
        expect(h.watcherStops).toBe(1)
        expect(h.receiverStops).toBe(h.receiverStarts)
        expect(h.actor.getSnapshot().context.request).toBeUndefined()
        expect(h.actor.getSnapshot().context.remoteDeviceId).toBeUndefined()
        h.answered.resolve(response)
        h.actor.send({ type: "signals.ready" })
        h.actor.send({ type: "file-request-response", response })
        h.actor.send({ type: "accept" })
        h.clock.increment(600_000)
        await settle()
        expect(h.actor.getSnapshot().value).toBe("idle")
      } finally {
        h.actor.stop()
      }
    })
  }
}

for (const action of ["accept", "decline"] as const) {
  for (const code of ["CONFLICT", "PRECONDITION_FAILED"]) {
    test(`${action} ${code} ends the attempt without a retry prompt`, async () => {
      const h = harness()
      try {
        h.receive()
        h.actor.send({ type: action })
        h.answered.reject(apiError(code))
        await settle()
        expect(h.actor.getSnapshot().value).toBe("idle")
        expect(h.controls()).not.toContain(">Retry<")
        expect(h.watcherStops).toBe(1)
        expect(h.receiverStops).toBe(h.receiverStarts)
      } finally {
        h.actor.stop()
      }
    })
  }
}

test("expiry dismisses an unanswered prompt but explicit cancellation stops an accepted transfer", async () => {
  const h = harness()
  try {
    h.receive()
    h.actor.send({ type: "file-request.expired", requestId: request.id })
    expect(h.actor.getSnapshot().value).toBe("idle")
    h.receive()
    h.actor.send({ type: "accept" })
    h.actor.send({ type: "file-request-response", response })
    const channel = { label: "file:a.txt", close: mock(() => {}) }
    h.actor.send({
      type: "peer.datachannel",
      event: { channel } as unknown as RTCDataChannelEvent,
    })
    expect(h.actor.getSnapshot().matches("receiving files")).toBe(true)
    h.actor.send({ type: "file-request.expired", requestId: request.id })
    expect(h.actor.getSnapshot().matches("receiving files")).toBe(true)
    h.actor.send({ type: "file-request.cancelled", requestId: request.id })
    expect(h.actor.getSnapshot().value).toBe("idle")
    expect(h.transferStops).toBe(1)
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(h.peer.close).toHaveBeenCalledTimes(1)
  } finally {
    h.actor.stop()
  }
})

test("cancellation observed before acceptance prevents caller negotiation", async () => {
  const h = harness()
  try {
    h.send()
    h.created.resolve({ ...request, id: h.requestId })
    await settle()
    h.actor.send({ type: "file-request.cancelled", requestId: h.requestId })
    h.actor.send({
      type: "file-request-response",
      response: { ...response, request_id: h.requestId },
    })
    expect(h.callerStarts).toBe(0)
    expect(h.actor.getSnapshot().value).toBe("idle")
  } finally {
    h.actor.stop()
  }
})

test("watcher retry preserves a receiver with committed acceptance and Dismiss cleans both actors", async () => {
  const h = harness()
  try {
    h.receive()
    h.actor.send({ type: "accept" })
    h.actor.send({ type: "file-request-response", response })
    h.actor.send({ type: "file-request-response.failed" })
    expect(h.controls()).toContain("Could not check the file request.")
    h.actor.send({ type: "retry-watcher" })
    expect(h.watchers).toBe(2)
    expect(h.watcherStops).toBe(1)
    expect(h.receiverStarts).toBe(1)
    expect(h.receiverStops).toBe(0)
    h.actor.send({ type: "file-request-response.failed" })
    h.actor.send({ type: "dismiss-watcher" })
    expect(h.actor.getSnapshot().value).toBe("idle")
    expect(h.watcherStops).toBe(2)
    expect(h.receiverStops).toBe(1)
  } finally {
    h.actor.stop()
  }
})

for (const cancellation of ["sender", "observed"] as const) {
  test(`${cancellation} cancellation still stops caller negotiation after watcher retry`, async () => {
    const h = harness()
    try {
      h.send()
      h.created.resolve({ ...request, id: h.requestId })
      await settle()
      h.actor.send({
        type: "file-request-response",
        response: { ...response, request_id: h.requestId },
      })
      h.actor.send({ type: "file-request-response.failed" })
      expect(h.actor.getSnapshot().value).toBe("connecting")
      expect(h.controls()).toContain("Could not check the file request.")
      h.actor.send({ type: "retry-watcher" })
      expect(h.callerStarts).toBe(1)
      expect(h.callerStops).toBe(0)
      expect(h.requestSignals).toHaveLength(1)
      if (cancellation === "sender") {
        h.actor.send({ type: "cancel" })
        expect(h.actor.getSnapshot().value).toBe("cancelling request")
        h.cancelled[0]!.resolve()
        await settle()
      } else {
        h.actor.send({ type: "file-request.cancelled", requestId: h.requestId })
      }
      expect(h.actor.getSnapshot().value).toBe("idle")
      expect(h.callerStops).toBe(1)
      expect(h.watcherStops).toBe(2)
      expect(h.peer.close).toHaveBeenCalledTimes(1)
    } finally {
      h.actor.stop()
    }
  })
}
