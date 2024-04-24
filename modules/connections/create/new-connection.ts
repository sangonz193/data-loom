import { SupabaseClient, User } from "@supabase/supabase-js"
import { assign, fromCallback, fromPromise, setup } from "xstate"

import { logger } from "@/logger"
import { Database, Tables } from "@/supabase/types"

import { createPairingCode, redeemPairingCode } from "./actions"
import { connectCallerPeerMachine } from "../connect-caller-peer"
import { connectReceiverPeerMachine } from "../connect-receiver-peer"

type Input = {
  supabase: SupabaseClient<Database>
  currentUser: User
}

interface Context extends Input {
  createdCode?: Awaited<ReturnType<typeof createPairingCode>>
  redeemCode?: string
  remoteUserId?: string
  peerConnection?: RTCPeerConnection
}

type Event =
  | {
      type: "create-code"
    }
  | {
      type: "redemption-received"
      remoteUserId: string
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
      createdCode: (
        _,
        pairingCode: Awaited<ReturnType<typeof createPairingCode>>,
      ) => pairingCode,
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
  },

  actors: {
    connectCallerPeerMachine,
    connectReceiverPeerMachine,
    createCode: fromPromise(() => createPairingCode()),
    listenForRedemptions: fromCallback<{ type: "noop" }, Context>((params) => {
      const sendBack = params.sendBack as (event: Event) => void
      const { supabase, createdCode } = params.input

      const channel = supabase
        .channel(Math.random().toString().substring(2, 20))
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "pairing_code_redemptions",
            filter: `${"pairing_code" satisfies keyof Tables<"pairing_code_redemptions">}=eq.${createdCode!.code}`,
          },
          (payload) => {
            const newRow = payload.new as Tables<"pairing_code_redemptions">
            sendBack({
              type: "redemption-received",
              remoteUserId: newRow.user_id,
            })
          },
        )
        .subscribe((status, err) => {
          logger.info(
            "[home] Listening to pairing code redemption status:",
            status,
          )
          if (err)
            logger.error(
              "[home] Error listening to pairing code redemption",
              err,
            )
        })

      return () => {
        supabase.removeChannel(channel)
      }
    }),
    createUserConnection: fromPromise<void, Context>(
      async ({ input: { currentUser, supabase, remoteUserId } }) => {
        const { error } = await supabase.from("user_connections").upsert(
          {
            user_1_id: currentUser.id,
            user_2_id: remoteUserId!,
          },
          {
            onConflict: `${"user_1_id" satisfies keyof Tables<"user_connections">},${"user_2_id" satisfies keyof Tables<"user_connections">}"`,
          },
        )

        if (error) {
          logger.error("[new-connection] Error creating user connection", error)
          throw error
        }
      },
    ),
    redeemCode: fromPromise(({ input }: { input: Context }) =>
      redeemPairingCode(input.redeemCode!),
    ),
    cleanup: fromCallback(({ input }: { input: Context }) => {
      return () => {
        const { peerConnection } = input
        peerConnection?.close()
      }
    }),
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QDswHcC0BjA9s1WALgJZ4B0xEANmAMRYBOYAhoWNjhGANoAMAuolAAHHLGIk8QkAA9EARgBMAVjLLeG+esUAWAOwAOZQDYdAGhABPRIoCcqlRt57jtg-L2KAzDoC+vi1RMXHwwIlJkCmo6Ji4wAFsOLj5BJBBRcUlkaTkEJVV1TW19I1MLazzFAzVvHR15Yy95XgaDf0D0DlDw8kYWEmQoAAJcLloIPDAKZAA3HABrKaCugiyyPtZiQZHOMAQtuaxNvBSU6QyJCJzEEx0yYz15W3kvRV4vPUMvcps9LzJPj4dI0vI1jO52iBliFVhEyFRiLA2MgtsMAGY4BhDWIJYRZWC0HHxPERDBMLBgYgzSBnNIXLLXPK8VxkZq2HS6XTGeTyAwGH4IFTVPS2cHc2yggy8Aw6ZSQ6F4WG9RVhAbDI5UGgMcaTaZzRbrFVEADCzE1YAYAAUwBaALLMLAACy2PAE5zElykaVyHiMZF4yh0BiFDylDQFdmMAJ0tljPgMovscoCUM6MNVcI2aqGAFdYBadt0sjrUHqFks00a1lnUbn81j0z1kPtZjgjllTm66R6Gd6bF4vLx-RpB8pRT4XnoI6Lo7GJUHE8pkx1glW4TiErXRnQJqWDuWyAqi+vIDb4lvdi3DsdkJ3UiIe1c+wgRbYyK93so+ezFC9zFYFEHf1ag+AMTA8Yxl1TVdj2VY9tnJSlqW1Xcpn3A0jyVSJG2zRCqQtK82xvO93UyJ9QB9LwE39QMZV0AwHnqAUtH+JwR30ZRmneLx-BTZBdngNJMIzL0HzI0TZEQDBjAFaTh00YxjGlZQfFcHi+MrWDIkoGhSM9bJnw5ZivzIepFMgpoqj0PwNJgrD1iYTZtm3PTewoxBQXkVlHgMQw+UMDwpwAwVPDIXQ52ed5PgMLwoOEpt4URZFawxLEiRJPBBLE-TGVfd83li78OT-CNQvCudmg+L44s0+ycK3M0tVc8jJLyKi3wDIMOSDRj5AjYxFFnWNFBcDRfxquyROwqtIGaiTchUT4yATZxIKXDl1CCiotGqMzFPeAbJUg+Vaqmhz+lrPMC3qiT6RahbmSHZwYs49QeSaUrBvK2NKui2KTsmhKN3PZzdjmgz3IQZQ-mW9kv1eeoGkURRmKqUyIrh7kwIBlYzvqhCwiQi1wcZZoWTZbquR5PlUd2jHZSxpdeN8IA */
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
    },

    connected: {
      type: "final",
    },

    "creating user connection": {
      invoke: {
        src: "createUserConnection",
        onDone: "connected",
        input: ({ context }) => context,
      },
    },

    "redeeming code": {
      invoke: {
        src: "redeemCode",
        input: ({ context }) => context,
        onDone: {
          target: "connecting receiver",
          actions: [
            {
              type: "saveRemoteUserIdToContext",
              params: ({ event }) => event.output.remoteUserId,
            },
            "createPeer",
          ],
        },
      },
    },

    "connecting receiver": {
      invoke: {
        src: "connectReceiverPeerMachine",
        onDone: "connected",
        input: ({ context }) => ({
          ...context,
          peerConnection: context.peerConnection!,
          remoteUserId: context.remoteUserId!,
        }),
      },
    },
  },
})
