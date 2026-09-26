import type { SupabaseClient, User } from "@supabase/supabase-js"
import type { TRPCClient } from "@trpc/client"
import { assign, fromCallback, fromPromise, setup } from "xstate"

import { logger } from "@/logger"
import type { AppRouter } from "@/modules/api/router"
import type { Database } from "@/supabase/types"

import type { CallerOutputEvent } from "../connect-caller-peer"
import { connectCallerPeerMachine } from "../connect-caller-peer"
import type { ReceiverOutputEvent } from "../connect-receiver-peer"
import { connectReceiverPeerMachine } from "../connect-receiver-peer"

type Input = {
  supabase: SupabaseClient<Database>
  currentUser: User
  deviceId: string
  trpcClient: TRPCClient<AppRouter>
}

interface Context extends Input {
  createdCode?: Awaited<
    ReturnType<TRPCClient<AppRouter>["pairing"]["create"]["mutate"]>
  >
  redeemCode?: string
  remoteUserId?: string
  peerConnection?: RTCPeerConnection
  isRedemptionListenerReady?: boolean
  connectionErrorEvent?: Extract<
    ReceiverOutputEvent,
    { type: "peer-connection.failed" }
  >
}

type Event =
  | CallerOutputEvent
  | ReceiverOutputEvent
  | {
      type: "create-code"
    }
  | {
      type: "redemption-received"
      remoteUserId: string
    }
  | {
      type: "redemption-listener.ready"
    }
  | {
      type: "redeem-code"
      code: string
    }

export const newConnectionMachine = setup({
  types: {
    context: {} as Context,
    input: {} as Input,
    events: {} as Event,
    children: {} as {
      connectCallerPeerMachine: "connectCallerPeerMachine"
    },
  },

  actions: {
    setCreatedCodeToContext: assign({
      createdCode: (_, pairingCode: NonNullable<Context["createdCode"]>) =>
        pairingCode,
    }),
    setRedeemCodeToContext: assign({
      redeemCode: (_, redeemCode: string) => redeemCode,
    }),
    createPeer: assign({
      peerConnection: () => new RTCPeerConnection(),
    }),
    saveRemoteUserIdToContext: assign({
      remoteUserId: (_, remoteUserId: string) => remoteUserId,
    }),
    setConnectionErrorEvent: assign({
      connectionErrorEvent: (_, event: Context["connectionErrorEvent"]) =>
        event,
    }),
    setRedemptionListenerReady: assign({
      isRedemptionListenerReady: () => true,
    }),
  },

  actors: {
    connectCallerPeerMachine,
    connectReceiverPeerMachine,
    createCode: fromPromise(({ input }: { input: Context }) =>
      input.trpcClient.pairing.create.mutate(),
    ),
    listenForRedemptions: fromCallback<{ type: "noop" }, Context>((params) => {
      const sendBack = params.sendBack as (event: Event) => void
      const { supabase, createdCode, deviceId } = params.input

      const channel = supabase
        .channel(`device:${deviceId}`, { config: { private: true } })
        .on("broadcast", { event: "pairing-redemption" }, ({ payload }) => {
          const redemption = payload as {
            code?: string
            remotePersonId?: string
          }
          if (
            redemption.code !== createdCode?.code ||
            !redemption.remotePersonId
          )
            return
          sendBack({
            type: "redemption-received",
            remoteUserId: redemption.remotePersonId,
          })
        })
        .subscribe((status, err) => {
          logger.info(
            "[new-connection] Listening to pairing code redemption status:",
            status,
          )
          if (err)
            logger.error(
              "[new-connection] Error listening to pairing code redemption",
              err,
            )
          if (status === "SUBSCRIBED") {
            sendBack({ type: "redemption-listener.ready" })
          }
        })

      return () => {
        supabase.removeChannel(channel)
      }
    }),
    createUserConnection: fromPromise(({ input }: { input: Context }) =>
      input.trpcClient.connections.create.mutate({
        remotePersonId: input.remoteUserId!,
      }),
    ),
    redeemCode: fromPromise(({ input }: { input: Context }) =>
      input.trpcClient.pairing.redeem.mutate({ code: input.redeemCode! }),
    ),
    notifyPairingOwner: fromPromise(({ input }: { input: Context }) =>
      input.trpcClient.pairing.notifyRedeemed.mutate({
        code: input.redeemCode!,
      }),
    ),
    cleanup: fromCallback(({ input }: { input: Context }) => {
      return () => {
        const { peerConnection } = input
        peerConnection?.close()
      }
    }),
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QDswHcC0BjA9s1WALgJZ4B0xEANmAMRYBOYAhoWNjhGANoAMAuolAAHHLGIk8QkAA9EARgBMAVjLLeG3gBZ5u5QA5FATi0AaEAE9EAZmXW1RgGzKA7PsePrW5T4C+v81RMXHwwIlJkCmo6Ji4wAFsOLj5BJBBRcUlkaTkEJVV1TR09QxNzKzzHeTIXQsNeeWtefSMDf0D0DlDw8kYWEmQoAAJcLloIPDAKZAA3HABrKaCugiyyPtZiQZHOMAQtuaxNvBSU6QyJCJzEZUctMkcXeSNeT2d9fTdym2tFMiVNEZDMYtLZrO0QMsQqsImQqMRYGxkFthgAzHAMIaxBLCLKwWjY+K4iIYJhYMDEGaQM5pC5Za55V73eS8EyKFweZTs-RmSw2eQuf6g7y8Yz6eQfR4QqF4GG9WVhAbDI5UGgMcaTaZzRbrBVEADCzFVYAYAAUwCaALLMLAACy2PAE5zElykaVyAtZZFZ1ncWkUGhZt2+CGsLj+ykaimFtScWhc0s60MVsOT4W2KrVtGEFoYKxT5FRzGINAgNJELvp7oULi9Pr9AYavGDfIQ7L+3msz0M8lcWnFieCerWGyVQwArrATTtulkNagtQslknh6mmJttpPp2msvtZjgjllTk7aZWrtW2+zqkYxZGtM3eByQ2GI1GY8o4wmApCV7PYdiEhRHYxgmBcDiXMgZT-cgAPiIDRj2cDDwiY9UgrTJz1AD0mX+Vl-Q5ZxuV5Cp5C0IwahcLx9GsGigXkO5B3zHpIh3ICyQpKl1VAqZwJ1KC5RY1dtnYykTT3Q5jmQVDnQwt0sJrOsjF9O5GyDRwQyUfQ1E0MNH3UJpakY1j5T-YSwg4k1s1zJi1iLEtqRPdDXWyC9PXI+sVMDZt1NbAVHG9TRPlaWiDEUfxv2QXZ4DSfiCxcpyq3khAMB8ioMFUIxMqy7KsvcIzV3ISgaBk5yGX9Z94weFw6I-bRFEefR8uglj1zHBCSsS2QbCqf4nhee9PDI+rnyaBxnC0MjqJ0VkmoEuEESRID0UxQliTwaKEswrqEGq8jfm0ZpmmsRxXhG3gxuUCagS8FkjFmuLdVM5UjTVDqto9Lt7HrLQPCcVxlGfRRqlZZxPscfRH19e7mMe1ZIDeuTtpUZ4yHqdQIdearrGfRwIz+m9eGsTL2UJ6GR1aoCt0xYz4vSM9EdyRs-g0NxKPjXGORcCqtIaLsAxcMilN+ZQyf-SALTgjNdgR2nckMewqho4xHBMDwvl8nrww8Z5fho+Nm1FkyYTM8lRIYGWGUaZwyB+46wycLx6uIhRNfqqolMUPXaxFiLfzmmmhhNBgMXh09ZNlxAmYC1mvA5dlHhDRRPm9RpSI+fQuQaLRwt8IA */
  id: "new-connection",

  initial: "idle",

  invoke: {
    src: "cleanup",
    input: ({ context }) => context,
  },

  context: ({ input }) => input,

  states: {
    idle: {
      on: {
        "create-code": "creating code",
        "redeem-code": {
          target: "redeeming code",
          actions: {
            type: "setRedeemCodeToContext",
            params: ({ event }) => event.code,
          },
        },
      },
    },

    "creating code": {
      invoke: {
        src: "createCode",
        input: ({ context }) => context,
        onError: "connection errored",
        onDone: {
          target: "listening for redemptions",
          actions: {
            type: "setCreatedCodeToContext",
            params: ({ event }) => event.output,
          },
        },
      },
    },

    "listening for redemptions": {
      invoke: {
        src: "listenForRedemptions",
        input: ({ context }) => context,
      },

      on: {
        "redemption-listener.ready": {
          actions: "setRedemptionListenerReady",
        },
        "redemption-received": {
          target: "connecting caller",
          actions: [
            {
              type: "saveRemoteUserIdToContext",
              params: ({ event }) => event.remoteUserId,
            },
            "createPeer",
          ],
        },
      },
    },

    "connecting caller": {
      invoke: {
        src: "connectCallerPeerMachine",
        id: "connectCallerPeerMachine",

        input: ({ context }) => ({
          ...context,
          peerConnection: context.peerConnection!,
          remoteUserId: context.remoteUserId!,
        }),

        onDone: {
          target: "creating user connection",
        },
      },

      on: {
        "peer-connection.failed": {
          target: "connection errored",
          actions: {
            type: "setConnectionErrorEvent",
            params: ({ event }) => event,
          },
        },
      },
    },

    connected: {
      type: "final",
    },

    "creating user connection": {
      invoke: {
        src: "createUserConnection",
        onDone: "connected",
        onError: "connection errored",
        input: ({ context }) => context,
      },
    },

    "redeeming code": {
      invoke: {
        src: "redeemCode",
        input: ({ context }) => context,
        onError: "connection errored",
        onDone: {
          target: "connecting receiver",
          actions: [
            {
              type: "saveRemoteUserIdToContext",
              params: ({ event }) => event.output.remotePersonId,
            },
            "createPeer",
          ],
        },
      },
    },

    "connecting receiver": {
      initial: "waiting for signaling",
      invoke: {
        src: "connectReceiverPeerMachine",
        onDone: "#new-connection.connected",
        input: ({ context }) => ({
          ...context,
          peerConnection: context.peerConnection!,
          remoteUserId: context.remoteUserId!,
        }),
      },
      states: {
        "waiting for signaling": {
          on: {
            "signals.ready": "notifying pairing owner",
          },
        },
        "notifying pairing owner": {
          invoke: {
            src: "notifyPairingOwner",
            input: ({ context }) => context,
            onDone: "waiting for connection",
            onError: "#new-connection.connection errored",
          },
        },
        "waiting for connection": {},
      },
      on: {
        "peer-connection.failed": {
          target: "#new-connection.connection errored",
          actions: {
            type: "setConnectionErrorEvent",
            params: ({ event }) => event,
          },
        },
      },
    },

    "connection errored": {
      type: "final",
    },
  },
})
