import { SupabaseClient, User } from "@supabase/supabase-js"
import { assign, sendTo, setup } from "xstate"

import { logger } from "@/logger"
import { Database, Json } from "@/supabase/types"

import { cleanUpSignalingRowsActor } from "./clean-up-signaling-rows"
import {
  ConnectPeerInputEvent,
  ConnectPeerOutputEvent,
  connectPeer,
} from "./connect-peer"
import { WebRtcSignalsOutputEvent, webRtcSignals } from "./web-rtc-signals"

type Input = {
  peerConnection: RTCPeerConnection
  supabase: SupabaseClient<Database>
  currentUser: User
  remoteUserId: string
}

type Context = Input & {
  dataChannel?: RTCDataChannel
  offer?: RTCSessionDescriptionInit
  answer?: RTCSessionDescriptionInit
  pendingIceCandidates: RTCIceCandidate[]
}

type Event = WebRtcSignalsOutputEvent | ConnectPeerOutputEvent

export const connectCallerPeerMachine = setup({
  types: {
    input: {} as Input,
    context: {} as Context,
    events: {} as Event,
  },
  actions: {
    removeDataChannel: assign({
      dataChannel: ({ context: { dataChannel } }) => {
        dataChannel?.close()
        return undefined
      },
    }),
    setOfferToContext: assign({
      offer: (_, offer: RTCSessionDescriptionInit) => offer,
    }),
    saveAnswerToContext: assign({
      answer: (_, answer: RTCSessionDescriptionInit) => answer,
    }),
    sendOffer: async (
      { context: { currentUser, remoteUserId, supabase } },
      offer: RTCSessionDescriptionInit,
    ) => {
      await supabase
        .from("web_rtc_signals")
        .insert({
          from_user_id: currentUser.id,
          to_user_id: remoteUserId,
          payload: offer as unknown as Json,
        })
        .then(({ error }) => {
          if (error)
            logger.error("[connectCallerPeerMachine] sendOffer error", error)
        })
    },
    sendIceCandidate: async (
      { context: { currentUser, remoteUserId, supabase } },
      candidate: RTCIceCandidate,
    ) => {
      await supabase
        .from("web_rtc_signals")
        .insert({
          from_user_id: currentUser.id,
          to_user_id: remoteUserId,
          payload: candidate as unknown as Json,
        })
        .then(({ error }) => {
          if (error)
            logger.error(
              "[connectCallerPeerMachine] sendIceCandidate error",
              error,
            )
        })
    },
  },
  actors: {
    cleanUpSignalingRows: cleanUpSignalingRowsActor,
    listenForSignals: webRtcSignals,
    connectPeer,
  },
  guards: {
    hasOffer: ({ context }) => context.offer !== undefined,
    hasAnswer: ({ context }) => context.answer !== undefined,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcC0ADmGAE6x7ICGANtaQMSwCWU6NsAdE8mBZehCYRKOMAG0ADAF1EoAqmY4mGWSAAeiAGwAOAIwcATAc2aALAGZdR7cfMAaEAE9EBiaY4BOCZt0nf20wDzTQBfEIc0TGx8IlJyKloGZlZ2Dn5YAHdSSRkkEHlFZXRVDQQdDw4rbQ9TU11TAFYAj00HZwQrMIiMLFxCYjI+RJJ6WJIKHuiijgg4ZBImAiUMHNUCpmXivNLNJo4TUwkPAHZdY7dzjzbEXQltDkbzCXNjk81zBvqukEjemIH4jQ6CMxhMorhprAAK7IHiwWAAMyh1FWeXWmxKiGOx2uCAapgqHw85gs5m0Ega5g82m+v2i-TiQ2BowGYL+024vCoAiEInE0jWCg2RUxZQJDwMug8ul0wQkBlMBnsTixNQ4DU0BgaBi8xwaLVltMmfTGgOGHAylGF6CgAAIEagSLb0lkRqi5EKMdsbvUJOqlQTgkqFeYDLjTJoKrdidHtNUPNSjeD-oyEsCOMg6PwmDbbVCCLaCCQwAA3ZRQ2DOnCiAC2S1g9AgGDAXHQJdQAGsW3STQCmaQM1n0Dm7fnC8Wy6gK1Xa-WEDn21RNjl3flPSLvQgyX6JLoNQY9buTnvwzoOETLKctVrjhGk38GYM0wP5mARCPbagEQiGKv0RvQFKPRzH2I5DjuWVyl0cMI0qUNjjMPRtQPJUwnCEB0FQWZ4DyHsUyfIFSEFQoVE3HVcQMbQQKJa9Xk0O4DHvelTX7EgLStJRcwdJ0XSItF11IwDEA8bVDAaCRdwkY4nn1MMVQQCNjnPWSE1DJpGmxJje1TQi2KbLBiOFQT1EQMkGg4Xd90PKVTgaXFtU0ZTiQ+M43HMYItPws100zN9h1zMci1LctKxEWccBwj0SK2ISEGxGCQO0FSZT3aSRIaTzH28gdYDAasP2LGtUFEZ10EyPioqMmKTI6SiKjueiXI8Ixgjs+TakS5KZQaNKGgy9C8Ky1iM2Ld9cy-H8SEMr1Yr8CyJPlbxpKpDVTyUmjVK1AIeuONCQiAA */
  id: "connect-peers-caller",

  context: ({ input }) => ({
    pendingIceCandidates: [],
    ...input,
  }),

  invoke: [
    {
      src: "connectPeer",
      id: "connectPeer",
      input: ({ context }) => ({
        calling: true,
        peerConnection: context.peerConnection,
      }),
    },
    {
      src: "listenForSignals",
      input: ({ context }) => context,
    },
  ],

  states: {
    "waiting for answer": {
      always: {
        target: "setting remote answer",
        guard: "hasAnswer",
      },
    },

    done: {
      entry: "removeDataChannel",
      type: "final",
    },

    "cleaning up previous attempts": {
      invoke: {
        src: "cleanUpSignalingRows",
        input: ({ context }) => context,
        onDone: "creating offer",
      },
    },

    "setting remote answer": {
      entry: sendTo("someActor", ({ context }) => ({
        type: "someEvent",
        data: context.answer!,
      })),
    },

    "creating offer": {
      always: {
        target: "waiting for answer",
        guard: "hasOffer",

        actions: {
          type: "sendOffer",
          params: ({ context }) => {
            if (!context.offer) throw new Error("No offer set in context")
            return context.offer
          },
        },
      },
    },
  },

  initial: "cleaning up previous attempts",

  on: {
    "signals.ice-candidate": {
      actions: sendTo(
        "connectPeer",
        ({ event }) =>
          ({
            type: "ice-candidate-received",
            candidate: event.iceCandidate,
          }) satisfies ConnectPeerInputEvent,
      ),
    },

    "signals.answer": {
      actions: sendTo(
        "connectPeer",
        ({ event }) =>
          ({
            type: "description-received",
            description: event.answer,
          }) satisfies ConnectPeerInputEvent,
      ),
    },

    "peer-connection.description": {
      actions: {
        type: "setOfferToContext",
        params: ({ event }) => event.description,
      },
    },

    "peer-connection.successful": ".done",

    "peer-connection.ice-candidate": {
      actions: {
        type: "sendIceCandidate",
        params: ({ event }) => event.candidate,
      },
    },
  },
})
