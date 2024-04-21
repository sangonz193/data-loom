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
  /** @xstate-layout N4IgpgJg5mDOIC5QDswHcC0BjA9s1WALgJZ4B0xEANmAMRYBOYAhoWNjhGANoAMAuolAAHHLGIk8QkAA9EARgBMAVjIAWAJxaNvDcoAcANn0B2NQGYANCACeiRWv1kVvXofMmNhxebeKAvv7WqJi4+GBEpMgU1HRMXGAAthxcfIJIIKLiksjScghKqpraugbGZla2iPryZMo+jvqKivJa+hoBQSAhHOGR5IwsJMhQAAS4XLQQeGAUyABuOADWsz1hBDlkg6zEI+OcYAi7i1g7eGlp0lkSUXmI9YpkhvImLeaGyp6elXYIzYZkEwmczFeTyQxqFpNQLBdC9DZRMhUYiwNjIXZjABmOAYo3iSWEOVgtHxiUJUQwTCwYGI80glwy1xydwKrichl0al48l4Hl5jmsvxatU8hg0HnkBmUrX0+hh3Th6wimyVkT2pyoNAYUxmc0WKy2eA2AGFmJqwAwAApgC0AWWYWAAFrseAIrmIblIMvkXg46so1MoNIH3KLDIL7JpAcpXEC2splOYVPK1kblYjtsMxgBXWAW-Z9HI61B65arRVp-rRTMY0a5-OqnJHBY4U45C5uxke5ne+yKMXqNrtBMWPQRv5Rkwx3hxjT6BNJ5QpiuFxH4pK1iZ0aYl45lsip1fkdeJTcHZsnM7IDvpETd269hDApxNXm6Hy8RTi-Tj-TmMifiC+i8oY3jeO8y6hJWKrQbWVI0nS2o7rMe4GoeCIDLBezwbSFoXq2V43u62QPqAPpJk4I7GPIahqMCZjhlUrIAq4rgSjo5ggs8gRdMgBzwBk6Hpl6d4kSJsiIBgjG-FJkHwsJ0SUDQxGerkj6QuOYK1Go4ImEokLcp4ShyY2GZMDs6oHCpPZkYg5g0WQYKvGCdG0Voajjs0qguLwdHgn+wZaCZsHkMiqJgOiezYripLkngAmiapLLPmQr6+B0vhfuYP5MV5zjTn5xjmIFGjBUe1ZYWMGpatZpESQUFH+mo1G0fRzWeZK0auBykqiko5hlRhFWFpAtXifkKgvGQxUzgGr7BoG456F1vnFSCHhAoYg0KVs5lZnWea4qZ4lMnVPraHUcb2XRHQ+D8fbeQVelFSV21VmQJ5nlwY1qbZCAPE8vryO8nwaN8v61NOn76DpTTmAmJhvTBq7YRECEWj9LI8rw7KctyvImPyOW-DUdSsYoMPyHDCalTxQA */
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
          currentUser: context.currentUser,
          peerConnection: new RTCPeerConnection(),
          remoteUserId: context.remoteUserId!,
          supabase: context.supabase,
        }),

        onDone: {
          target: "creating user connection",
          reenter: true,
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
          actions: {
            type: "saveRemoteUserIdToContext",
            params: ({ event }) => event.output.remoteUserId,
          },
        },
      },
    },

    "connecting receiver": {
      invoke: {
        src: "connectReceiverPeerMachine",
        onDone: "connected",
        input: ({ context }) => ({
          currentUser: context.currentUser,
          peerConnection: new RTCPeerConnection(),
          remoteUserId: context.remoteUserId!,
          supabase: context.supabase,
        }),
      },
    },
  },
})
