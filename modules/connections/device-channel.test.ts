import { createClient, type RealtimeChannel } from "@supabase/supabase-js"
import { afterEach, expect, jest, spyOn, test } from "bun:test"
import { createActor, createMachine, fromCallback, fromPromise } from "xstate"

import type { Database } from "@/supabase/types"

import { connectCallerPeerMachine } from "./connect-caller-peer"
import { connectReceiverPeerMachine } from "./connect-receiver-peer"
import { newConnectionMachine } from "./create/new-connection"
import { webRtcSignals } from "./web-rtc-signals"

const deviceId = crypto.randomUUID()
const remoteUserId = crypto.randomUUID()
const remoteDeviceId = crypto.randomUUID()
const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  jest.useRealTimers()
})

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

function client() {
  const supabase = createClient<Database>("http://localhost:1", "test-key", {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
  spyOn(supabase.realtime, "connect").mockImplementation(() => {})
  cleanups.push(async () => {
    await supabase.removeAllChannels()
    await supabase.realtime.disconnect()
  })
  return supabase
}

function subscribe(
  supabase: ReturnType<typeof client>,
  address = { deviceId, remoteUserId, remoteDeviceId },
) {
  const events: { type: string; error?: { type: string } }[] = []
  const actor = createActor(
    createMachine({
      invoke: {
        src: webRtcSignals,
        input: { supabase, ...address },
      },
      on: {
        "*": {
          actions: ({ event }) => {
            events.push(event)
          },
        },
      },
    }),
  ).start()
  cleanups.push(() => actor.stop())
  return { actor, events }
}

function joined(channel: RealtimeChannel) {
  channel.joinPush.trigger("ok", {})
}

function disconnected(channel: RealtimeChannel) {
  const socket = channel.joinPush.channel.socket
  spyOn(socket, "connect").mockImplementation(() => {})
  socket.onConnClose(new CloseEvent("close", { code: 1006 }))
  expect(channel.state).toBe("errored")
}

function rejoined(channel: RealtimeChannel) {
  channel.joinPush.channel.socket.onConnOpen()
  expect(channel.state).toBe("joining")
  joined(channel)
  expect(channel.state).toBe("joined")
}

function broadcast(
  channel: RealtimeChannel,
  event = "signal",
  payload: unknown = {
    fromPersonId: remoteUserId,
    fromDeviceId: remoteDeviceId,
    payload: { type: "answer", sdp: "answer" },
  },
) {
  channel.joinPush.channel.trigger("broadcast", { event, payload })
}

test("installed SDK reuses topics and ignores a second subscription callback", async () => {
  const supabase = client()
  const first = supabase.channel(`device:${deviceId}`, {
    config: { private: true },
  })
  const firstStatuses: string[] = []
  const secondStatuses: string[] = []
  first.subscribe((status) => firstStatuses.push(status))
  const second = supabase.channel(`device:${deviceId}`)
  second.subscribe((status) => secondStatuses.push(status))
  expect(second).toBe(first)
  joined(first)
  expect(firstStatuses).toEqual(["SUBSCRIBED"])
  expect(secondStatuses).toEqual([])
  await supabase.removeChannel(first)
  expect(second.state).toBe("closed")
})

test("two signal consumers both become ready and one cleanup preserves the other", async () => {
  const supabase = client()
  const remove = spyOn(supabase, "removeChannel")
  const first = subscribe(supabase)
  const second = subscribe(supabase)
  const channel = supabase.getChannels()[0]!
  expect(channel.private).toBe(true)
  expect(channel.topic).toBe(`realtime:device:${deviceId}`)
  expect(supabase.getChannels()).toHaveLength(1)
  expect(first.events).toEqual([])
  expect(second.events).toEqual([])
  joined(channel)
  expect(first.events).toEqual([{ type: "signals.ready" }])
  expect(second.events).toEqual([{ type: "signals.ready" }])
  broadcast(channel)
  expect(first.events.at(-1)?.type).toBe("signals.answer")
  expect(second.events.at(-1)?.type).toBe("signals.answer")
  first.actor.stop()
  expect(remove).not.toHaveBeenCalled()
  broadcast(channel)
  expect(first.events).toHaveLength(2)
  expect(second.events).toHaveLength(3)
  second.actor.stop()
  await settle()
  expect(remove).toHaveBeenCalledTimes(1)
  expect(supabase.getChannels()).toEqual([])
})

test("a late signal consumer receives readiness on the joined channel", async () => {
  const supabase = client()
  const first = subscribe(supabase)
  const channel = supabase.getChannels()[0]!
  joined(channel)
  const second = subscribe(supabase)
  await settle()
  expect(second.events).toEqual([{ type: "signals.ready" }])
  expect(first.events).toEqual([{ type: "signals.ready" }])
  broadcast(channel)
  expect(second.events.at(-1)?.type).toBe("signals.answer")
})

test("installed SDK reports socket loss and rejoins the same channel", () => {
  const supabase = client()
  const channel = supabase.channel(`device:${deviceId}`)
  const statuses: string[] = []
  channel.subscribe((status) => statuses.push(status))
  joined(channel)
  disconnected(channel)
  rejoined(channel)
  expect(statuses).toEqual(["SUBSCRIBED", "CHANNEL_ERROR", "SUBSCRIBED"])
  expect(supabase.getChannels()).toEqual([channel])
})

test("reconnect preserves consumers and only readies waiting consumers once", async () => {
  jest.useFakeTimers()
  const supabase = client()
  const remove = spyOn(supabase, "removeChannel")
  const first = subscribe(supabase)
  const second = subscribe(supabase)
  const channel = supabase.getChannels()[0]!
  joined(channel)
  disconnected(channel)
  const canceled = subscribe(supabase)
  const late = subscribe(supabase)
  expect(late.events).toEqual([])
  canceled.actor.stop()
  channel.joinPush.channel.trigger("phx_error", {})
  rejoined(channel)
  for (const consumer of [first, second, late]) {
    expect(consumer.events).toEqual([{ type: "signals.ready" }])
  }
  broadcast(channel)
  for (const consumer of [first, second, late]) {
    expect(consumer.events.at(-1)?.type).toBe("signals.answer")
  }
  disconnected(channel)
  rejoined(channel)
  jest.advanceTimersByTime(10_000)
  for (const consumer of [first, second, late]) {
    expect(
      consumer.events.filter(({ type }) => type === "signals.ready"),
    ).toHaveLength(1)
    expect(
      consumer.events.some(({ type }) => type === "peer-connection.failed"),
    ).toBe(false)
  }
  expect(canceled.events).toEqual([])
  first.actor.stop()
  second.actor.stop()
  expect(remove).not.toHaveBeenCalled()
  late.actor.stop()
  await settle()
  expect(remove).toHaveBeenCalledTimes(1)
  expect(supabase.getChannels()).toEqual([])
})

test("a consumer joining during disconnection has its own initial readiness deadline", async () => {
  jest.useFakeTimers()
  const supabase = client()
  const first = subscribe(supabase)
  const channel = supabase.getChannels()[0]!
  joined(channel)
  disconnected(channel)
  const late = subscribe(supabase)
  jest.advanceTimersByTime(10_000)
  await settle()
  expect(late.events).toEqual([
    { type: "peer-connection.failed", error: { type: "unknown" } },
  ])
  expect(first.events).toEqual([{ type: "signals.ready" }])
  expect(supabase.getChannels()).toEqual([channel])
  rejoined(channel)
  broadcast(channel)
  expect(first.events.at(-1)?.type).toBe("signals.answer")
  expect(late.events).toHaveLength(1)
})

test("canceling every consumer during disconnection cleans up and allows reacquisition", async () => {
  const supabase = client()
  const first = subscribe(supabase)
  const old = supabase.getChannels()[0]!
  joined(old)
  disconnected(old)
  const pending = subscribe(supabase)
  first.actor.stop()
  pending.actor.stop()
  await settle()
  expect(supabase.getChannels()).toEqual([])
  expect(pending.events).toEqual([])
  const next = subscribe(supabase)
  const channel = supabase.getChannels()[0]!
  expect(channel).not.toBe(old)
  rejoined(channel)
  expect(next.events).toEqual([{ type: "signals.ready" }])
  expect(pending.events).toEqual([])
})

test("reacquisition waits for removal before creating a fresh subscription", async () => {
  const supabase = client()
  const remove = supabase.removeChannel.bind(supabase)
  let finish!: () => void
  spyOn(supabase, "removeChannel").mockImplementationOnce(
    (channel) =>
      new Promise((resolve) => {
        finish = () => {
          void remove(channel).then(resolve)
        }
      }),
  )
  const first = subscribe(supabase)
  const old = supabase.getChannels()[0]!
  joined(old)
  first.actor.stop()
  const second = subscribe(supabase)
  expect(second.events).toEqual([])
  await settle()
  finish()
  await settle()
  const next = supabase.getChannels()[0]!
  expect(next).toBeDefined()
  expect(next).not.toBe(old)
  expect(next.state).toBe("joining")
  joined(next)
  expect(second.events).toEqual([{ type: "signals.ready" }])
})

for (const failure of ["error", "rejection", "timeout"] as const) {
  test(`SDK removal ${failure} recovers without reusing the old channel or letting it close the replacement`, async () => {
    jest.useFakeTimers()
    const supabase = client()
    const first = subscribe(supabase)
    const old = supabase.getChannels()[0]!
    const phoenix = old.joinPush.channel
    const unsubscribe = spyOn(old, "unsubscribe")
    joined(old)
    if (failure === "timeout") {
      spyOn(phoenix.socket, "push").mockImplementationOnce(() => {})
      spyOn(phoenix.socket, "isConnected").mockReturnValueOnce(true)
      spyOn(phoenix, "isJoined").mockReturnValueOnce(true)
    } else {
      spyOn(phoenix.socket, "push").mockImplementationOnce((message) => {
        if (failure === "rejection") throw new Error("transport failed")
        phoenix.trigger(
          "phx_reply",
          { status: "error", response: {} },
          message.ref,
        )
      })
    }
    first.actor.stop()
    const canceled = subscribe(supabase)
    canceled.actor.stop()
    const waiting = subscribe(supabase)
    await settle()
    if (failure === "timeout") {
      expect(supabase.getChannels()).toEqual([old])
      jest.advanceTimersByTime(10_000)
      await settle()
      expect(waiting.events).toEqual([
        { type: "peer-connection.failed", error: { type: "unknown" } },
      ])
    } else {
      expect(unsubscribe).toHaveBeenLastCalledWith(0)
      const recovered = supabase.getChannels()[0]!
      expect(recovered).not.toBe(old)
      joined(recovered)
      expect(waiting.events).toEqual([{ type: "signals.ready" }])
      waiting.actor.stop()
      await settle()
    }
    expect(old.state).toBe("closed")
    expect(supabase.getChannels()).toEqual([])

    const second = subscribe(supabase)
    const third = subscribe(supabase)
    const next = supabase.getChannels()[0]!
    expect(next).not.toBe(old)
    joined(next)
    expect(second.events).toEqual([{ type: "signals.ready" }])
    expect(third.events).toEqual([{ type: "signals.ready" }])
    phoenix.trigger("phx_close", {})
    phoenix.trigger("phx_error", {})
    jest.advanceTimersByTime(10_000)
    expect(supabase.getChannels()).toEqual([next])
    expect(next.state).toBe("joined")
    second.actor.stop()
    broadcast(next)
    expect(third.events.at(-1)?.type).toBe("signals.answer")
    expect(canceled.events).toEqual([])
    third.actor.stop()
    await settle()
    expect(supabase.getChannels()).toEqual([])
  })
}

for (const failure of ["error", "rejection"] as const) {
  test(`recovery ${failure} keeps the old topic reserved and later acquisitions retry serialized cleanup`, async () => {
    const supabase = client()
    const first = subscribe(supabase)
    const old = supabase.getChannels()[0]!
    joined(old)
    const phoenix = old.joinPush.channel
    const push = spyOn(phoenix.socket, "push")
    for (let attempt = 0; attempt < 2; attempt++) {
      push.mockImplementationOnce((message) => {
        if (failure === "rejection") throw new Error("transport failed")
        phoenix.trigger(
          "phx_reply",
          { status: "error", response: {} },
          message.ref,
        )
      })
    }
    first.actor.stop()
    const failed = subscribe(supabase)
    await settle()
    expect(failed.events).toEqual([
      { type: "peer-connection.failed", error: { type: "unknown" } },
    ])
    expect(supabase.getChannels()).toEqual([old])
    expect(old.state).toBe("leaving")

    const second = subscribe(supabase)
    const third = subscribe(supabase)
    const canceled = subscribe(supabase)
    canceled.actor.stop()
    await settle()
    const next = supabase.getChannels()[0]!
    expect(supabase.getChannels()).toHaveLength(1)
    expect(next).not.toBe(old)
    joined(next)
    expect(second.events).toEqual([{ type: "signals.ready" }])
    expect(third.events).toEqual([{ type: "signals.ready" }])
    expect(canceled.events).toEqual([])
    phoenix.trigger("phx_close", {})
    expect(supabase.getChannels()).toEqual([next])
  })
}

for (const failure of [
  "error",
  "timeout",
  "closed",
  "disconnected",
  "rejoin-timeout",
  "rejoin-closed",
] as const) {
  test(`subscription ${failure} fails all owners, cleans up, and permits reacquisition`, async () => {
    const supabase = client()
    const first = subscribe(supabase)
    const second = subscribe(supabase)
    const channel = supabase.getChannels()[0]!
    if (failure === "rejoin-timeout" || failure === "rejoin-closed") {
      joined(channel)
      disconnected(channel)
      const pending = subscribe(supabase)
      channel.joinPush.channel.socket.onConnOpen()
      if (failure === "rejoin-timeout") channel.joinPush.trigger("timeout", {})
      else channel.joinPush.channel.trigger("phx_close", {})
      expect(pending.events).toEqual([
        { type: "peer-connection.failed", error: { type: "unknown" } },
      ])
    } else if (failure === "closed") {
      joined(channel)
      channel.joinPush.channel.trigger("phx_close", {})
    } else if (failure === "disconnected") {
      disconnected(channel)
    } else channel.joinPush.trigger(failure, { reason: "unavailable" })
    await settle()
    for (const consumer of [first, second]) {
      expect(consumer.events.at(-1)).toEqual({
        type: "peer-connection.failed",
        error: { type: "unknown" },
      })
    }
    expect(supabase.getChannels()).toEqual([])
    const next = subscribe(supabase)
    joined(supabase.getChannels()[0]!)
    expect(next.events).toEqual([{ type: "signals.ready" }])
    first.actor.stop()
    second.actor.stop()
    expect(supabase.getChannels()).toHaveLength(1)
  })
}

test("client and device subscriptions are isolated while shared listeners retain device pinning", () => {
  const supabase = client()
  const otherClient = client()
  const siblingDeviceId = crypto.randomUUID()
  const first = subscribe(supabase)
  const sibling = subscribe(supabase, {
    deviceId,
    remoteUserId,
    remoteDeviceId: siblingDeviceId,
  })
  const otherDevice = subscribe(supabase, {
    deviceId: crypto.randomUUID(),
    remoteUserId,
    remoteDeviceId,
  })
  const independent = subscribe(otherClient)
  const channel = supabase.getChannels()[0]!
  expect(supabase.getChannels()).toHaveLength(2)
  expect(otherClient.getChannels()).toHaveLength(1)
  joined(channel)
  broadcast(channel)
  expect(first.events.at(-1)?.type).toBe("signals.answer")
  expect(sibling.events).toEqual([{ type: "signals.ready" }])
  expect(otherDevice.events).toEqual([])
  expect(independent.events).toEqual([])
  broadcast(channel, "signal", {
    fromPersonId: remoteUserId,
    fromDeviceId: siblingDeviceId,
    payload: { type: "answer", sdp: "sibling" },
  })
  expect(first.events).toHaveLength(2)
  expect(sibling.events.at(-1)?.type).toBe("signals.answer")
})

test("a synchronous subscription failure reaches the failure path and permits reacquisition", async () => {
  const supabase = client()
  const channel = supabase.channel(`device:${deviceId}`, {
    config: { private: true },
  })
  spyOn(channel, "subscribe").mockImplementationOnce(() => {
    throw new Error("unavailable")
  })
  const failed = subscribe(supabase)
  expect(failed.events).toEqual([
    { type: "peer-connection.failed", error: { type: "unknown" } },
  ])
  await settle()
  expect(supabase.getChannels()).toEqual([])
  const next = subscribe(supabase)
  joined(supabase.getChannels()[0]!)
  expect(next.events).toEqual([{ type: "signals.ready" }])
})

test("readiness has a deadline even when the SDK never reports a status", async () => {
  jest.useFakeTimers()
  const supabase = client()
  const channel = supabase.channel(`device:${deviceId}`, {
    config: { private: true },
  })
  spyOn(channel, "subscribe").mockReturnValueOnce(channel)
  const first = subscribe(supabase)
  const second = subscribe(supabase)
  jest.advanceTimersByTime(10_000)
  await settle()
  for (const consumer of [first, second]) {
    expect(consumer.events).toEqual([
      { type: "peer-connection.failed", error: { type: "unknown" } },
    ])
  }
  expect(supabase.getChannels()).toEqual([])
  const next = subscribe(supabase)
  joined(supabase.getChannels()[0]!)
  jest.advanceTimersByTime(10_000)
  expect(next.events).toEqual([{ type: "signals.ready" }])
})

test("canceled and timed out owners waiting for removal never attach to the next channel", async () => {
  jest.useFakeTimers()
  const supabase = client()
  const remove = supabase.removeChannel.bind(supabase)
  let finish!: () => void
  spyOn(supabase, "removeChannel").mockImplementationOnce(
    (channel) =>
      new Promise((resolve) => {
        finish = () => {
          void remove(channel).then(resolve)
        }
      }),
  )
  const first = subscribe(supabase)
  joined(supabase.getChannels()[0]!)
  first.actor.stop()
  const canceled = subscribe(supabase)
  const timedOut = subscribe(supabase)
  canceled.actor.stop()
  jest.advanceTimersByTime(10_000)
  await settle()
  expect(canceled.events).toEqual([])
  expect(timedOut.events).toEqual([
    { type: "peer-connection.failed", error: { type: "unknown" } },
  ])
  const next = subscribe(supabase)
  finish()
  await settle()
  joined(supabase.getChannels()[0]!)
  expect(next.events).toEqual([{ type: "signals.ready" }])
  expect(canceled.events).toEqual([])
  expect(timedOut.events).toHaveLength(1)
})

for (const transferActive of [false, true]) {
  test(`pairing recovers and hands off once to caller signaling with${transferActive ? "" : "out"} an active transfer`, async () => {
    jest.useFakeTimers()
    const supabase = client()
    const transfer = transferActive ? subscribe(supabase) : undefined
    if (transfer) joined(supabase.getChannels()[0]!)
    let negotiations = 0
    let redemptionsReady = 0
    const machine = newConnectionMachine.provide({
      actions: {
        createPeer: () => {},
        setRedemptionListenerReady: () => {
          redemptionsReady += 1
        },
      },
      actors: {
        createCode: fromPromise(async () => ({
          code: "PAIRCODE",
          created_at: new Date().toISOString(),
        })),
        connectCallerPeerMachine: connectCallerPeerMachine.provide({
          actors: {
            cleanUpSignalingRows: fromPromise(async () => {}),
            connectPeer: fromCallback(() => {
              negotiations += 1
            }),
          },
        }),
      },
    })
    const actor = createActor(machine, {
      input: {
        supabase,
        deviceId,
        currentUser: {} as never,
        trpcClient: {} as never,
      },
    }).start()
    cleanups.push(() => actor.stop())
    actor.send({ type: "create-code" })
    await settle()
    const channel = supabase.getChannels()[0]!
    if (!transfer) joined(channel)
    expect(redemptionsReady).toBe(1)
    disconnected(channel)
    jest.advanceTimersByTime(30_000)
    await settle()
    expect(actor.getSnapshot().value).toBe("listening for redemptions")
    expect(supabase.getChannels()).toEqual([channel])
    expect(negotiations).toBe(0)
    rejoined(channel)
    expect(redemptionsReady).toBe(1)
    broadcast(channel, "pairing-redemption", {
      code: "PAIRCODE",
      remotePersonId: remoteUserId,
      remoteDeviceId,
    })
    await settle()
    const callerChannel = supabase.getChannels()[0]!
    expect(callerChannel).toBeDefined()
    if (!transfer) {
      expect(negotiations).toBe(0)
      joined(callerChannel)
      await settle()
    } else expect(callerChannel).toBe(channel)
    expect(negotiations).toBe(1)
    expect(actor.getSnapshot().value).toBe("connecting caller")
    disconnected(callerChannel)
    rejoined(callerChannel)
    broadcast(callerChannel, "pairing-redemption", {
      code: "PAIRCODE",
      remotePersonId: remoteUserId,
      remoteDeviceId,
    })
    await settle()
    expect(negotiations).toBe(1)
    expect(redemptionsReady).toBe(1)
    actor.stop()
    if (transfer) {
      broadcast(channel)
      expect(transfer.events.at(-1)?.type).toBe("signals.answer")
    }
  })
}

test("pairing subscription failure exits the redemption spinner", async () => {
  const supabase = client()
  const actor = createActor(
    newConnectionMachine.provide({
      actors: {
        createCode: fromPromise(async () => ({
          code: "PAIRCODE",
          created_at: new Date().toISOString(),
        })),
      },
    }),
    {
      input: {
        supabase,
        deviceId,
        currentUser: {} as never,
        trpcClient: {} as never,
      },
    },
  ).start()
  cleanups.push(() => actor.stop())
  actor.send({ type: "create-code" })
  await settle()
  supabase.getChannels()[0]!.joinPush.trigger("timeout", {})
  await settle()
  expect(actor.getSnapshot().value).toBe("connection errored")
  expect(supabase.getChannels()).toEqual([])
})

for (const machine of [connectCallerPeerMachine, connectReceiverPeerMachine]) {
  test(`${machine.id} forwards subscription failure through the existing parent failure path`, async () => {
    const supabase = client()
    const actor = createActor(
      createMachine({
        initial: "connecting",
        states: {
          connecting: {
            invoke: {
              src: machine.provide({
                actors: {
                  cleanUpSignalingRows: fromPromise(async () => {}),
                  connectPeer: fromCallback(() => {}),
                },
              }),
              input: {
                supabase,
                deviceId,
                remoteUserId,
                remoteDeviceId,
                currentUser: {} as never,
                trpcClient: {} as never,
                peerConnection: {} as never,
              },
            },
            on: { "peer-connection.failed": "failed" },
          },
          failed: {},
        },
      }),
    ).start()
    cleanups.push(() => actor.stop())
    supabase.getChannels()[0]!.joinPush.trigger("error", { reason: "denied" })
    await settle()
    expect(actor.getSnapshot().value).toBe("failed")
    expect(supabase.getChannels()).toEqual([])
  })
}
