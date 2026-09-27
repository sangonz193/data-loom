import { expect, test } from "bun:test"
import {
  createActor,
  fromCallback,
  fromPromise,
  type SnapshotFrom,
} from "xstate"

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
  actor.send({ type: "redemption-received", remoteUserId: "person-b" })
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
