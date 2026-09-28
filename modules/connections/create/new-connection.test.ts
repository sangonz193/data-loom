import { createTRPCClient, httpLink } from "@trpc/client"
import { expect, test } from "bun:test"
import superjson from "superjson"
import {
  createActor,
  fromCallback,
  fromPromise,
  type SnapshotFrom,
} from "xstate"

import type { AppRouter } from "@/modules/api/router"

import { connectCallerPeerMachine } from "../connect-caller-peer"
import { connectReceiverPeerMachine } from "../connect-receiver-peer"
import { newConnectionMachine } from "./new-connection"

type MachineContext = SnapshotFrom<typeof newConnectionMachine>["context"]

const input = {
  supabase: {} as never,
  currentUser: {} as never,
  deviceId: "device-a",
  trpcClient: {} as never,
}

test("redemption preserves 429 and never retries automatically", async () => {
  let calls = 0
  const trpcClient = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://localhost/api/trpc",
        transformer: superjson,
        fetch: async () => {
          calls++
          return Response.json(
            {
              error: superjson.serialize({
                message: "Too many attempts",
                code: -32029,
                data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 },
              }),
            },
            { status: 429 },
          )
        },
      }),
    ],
  })
  const actor = createActor(newConnectionMachine, {
    input: { ...input, trpcClient },
  }).start()
  try {
    actor.send({ type: "redeem-code", code: "PAIRCODE" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(actor.getSnapshot().value).toBe("connection errored")
    expect(actor.getSnapshot().context.redemptionErrorCode).toBe(
      "TOO_MANY_REQUESTS",
    )
    expect(actor.getSnapshot().context.peerConnection).toBeUndefined()
    actor.send({ type: "redeem-code", code: "PAIRCODE" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBe(1)
  } finally {
    actor.stop()
  }
})

async function settle() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

test("failed connection creation exits the caller spinner", async () => {
  const machine = newConnectionMachine.provide({
    actions: { createPeer: () => undefined },
    actors: {
      createCode: fromPromise(async () => ({
        code: "PAIRCODE",
        created_at: new Date().toISOString(),
      })),
      listenForRedemptions: fromCallback(() => () => undefined),
      connectCallerPeerMachine: fromPromise(
        async () => undefined,
      ) as unknown as typeof connectCallerPeerMachine,
      createUserConnection: fromPromise<void, MachineContext>(async () => {
        throw new Error("Code expired")
      }),
    },
  })
  const actor = createActor(machine, { input }).start()
  actor.send({ type: "create-code" })
  await settle()
  expect(actor.getSnapshot().value).toBe("listening for redemptions")
  actor.send({ type: "redemption-listener.ready" })
  expect(actor.getSnapshot().context.isRedemptionListenerReady).toBe(true)
  actor.send({
    type: "redemption-received",
    remoteUserId: "person-b",
    remoteDeviceId: "device-b",
  })
  await settle()
  expect(actor.getSnapshot().value).toBe("connection errored")
  actor.stop()
})

test("failed pairing notification exits the receiver spinner", async () => {
  const machine = newConnectionMachine.provide({
    actions: { createPeer: () => undefined },
    actors: {
      redeemCode: fromPromise(async () => ({ remotePersonId: "person-a" })),
      connectReceiverPeerMachine: fromCallback(
        () => () => undefined,
      ) as unknown as typeof connectReceiverPeerMachine,
      notifyPairingOwner: fromPromise<void, MachineContext>(async () => {
        throw new Error("Broadcast failed")
      }),
    },
  })
  const actor = createActor(machine, { input }).start()
  actor.send({ type: "redeem-code", code: "PAIRCODE" })
  await settle()
  expect(actor.getSnapshot().value).toEqual({
    "connecting receiver": "waiting for signaling",
  })
  actor.send({ type: "signals.ready" })
  await settle()
  expect(actor.getSnapshot().value).toBe("connection errored")
  actor.stop()
})

for (const action of ["create-code", "redeem-code"] as const) {
  test(`${action} failure exits its spinner`, async () => {
    const machine = newConnectionMachine.provide({
      actors: {
        createCode: fromPromise<
          { code: string; created_at: string },
          MachineContext
        >(async () => {
          throw new Error("Unavailable")
        }),
        redeemCode: fromPromise<{ remotePersonId: string }, MachineContext>(
          async () => {
            throw new Error("Code revoked")
          },
        ),
      },
    })
    const actor = createActor(machine, { input }).start()
    if (action === "create-code") actor.send({ type: action })
    else actor.send({ type: action, code: "PAIRCODE" })
    await settle()
    expect(actor.getSnapshot().value).toBe("connection errored")
    actor.stop()
  })
}

test("owner waits for subscription and passes the matching redemption device to the caller", async () => {
  const remoteUserId = crypto.randomUUID()
  const remoteDeviceId = crypto.randomUUID()
  let notify!: (payload: unknown) => void
  let subscribed!: (status: string) => void
  let callerInput: unknown
  const channel = {
    on: (
      _type: string,
      _filter: unknown,
      callback: (event: { payload: unknown }) => void,
    ) => {
      notify = (payload) => callback({ payload })
      return channel
    },
    subscribe: (callback: (status: string) => void) => {
      subscribed = callback
      return channel
    },
  }
  const machine = newConnectionMachine.provide({
    actions: { createPeer: () => {} },
    actors: {
      createCode: fromPromise(async () => ({
        code: "PAIRCODE",
        created_at: new Date().toISOString(),
      })),
      connectCallerPeerMachine: fromCallback(({ input }) => {
        callerInput = input
      }) as unknown as typeof connectCallerPeerMachine,
    },
  })
  const actor = createActor(machine, {
    input: {
      ...input,
      supabase: { channel: () => channel, removeChannel: () => {} } as never,
    },
  }).start()
  actor.send({ type: "create-code" })
  await settle()
  expect(actor.getSnapshot().context.isRedemptionListenerReady).toBeFalsy()
  subscribed("SUBSCRIBED")
  expect(actor.getSnapshot().context.isRedemptionListenerReady).toBe(true)
  for (const payload of [
    null,
    { code: "PAIRCODE", remotePersonId: remoteUserId },
    { code: "OTHER", remotePersonId: remoteUserId, remoteDeviceId },
    {
      code: "PAIRCODE",
      remotePersonId: remoteUserId,
      remoteDeviceId: "invalid",
    },
  ])
    notify(payload)
  expect(callerInput).toBeUndefined()
  notify({ code: "PAIRCODE", remotePersonId: remoteUserId, remoteDeviceId })
  expect(callerInput).toMatchObject({
    remoteUserId,
    remoteDeviceId,
    deviceId: input.deviceId,
  })
  actor.stop()
})

test("redeemer subscribes before notifying with its device and bootstraps with only the expected person", async () => {
  const notifications: unknown[] = []
  let receiverInput: unknown
  const machine = newConnectionMachine.provide({
    actions: { createPeer: () => {} },
    actors: {
      redeemCode: fromPromise(async () => ({ remotePersonId: "owner" })),
      connectReceiverPeerMachine: fromCallback(({ input }) => {
        receiverInput = input
      }) as unknown as typeof connectReceiverPeerMachine,
    },
  })
  const actor = createActor(machine, {
    input: {
      ...input,
      trpcClient: {
        pairing: {
          notifyRedeemed: {
            mutate: async (value: unknown) => {
              notifications.push(value)
            },
          },
        },
      } as never,
    },
  }).start()
  actor.send({ type: "redeem-code", code: "PAIRCODE" })
  await settle()
  expect(receiverInput).toMatchObject({
    remoteUserId: "owner",
    deviceId: input.deviceId,
  })
  expect((receiverInput as MachineContext).remoteDeviceId).toBeUndefined()
  expect(notifications).toEqual([])
  actor.send({ type: "signals.ready" })
  await settle()
  expect(notifications).toEqual([
    { code: "PAIRCODE", deviceId: input.deviceId },
  ])
  actor.stop()
})
