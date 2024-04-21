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
    children: {} as {
      cleanUpSignalingRows: "cleanUpSignalingRows"
      webRtcSignals: "webRtcSignals"
      connectPeer: "connectPeer"
    },
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
      logger.info("[connectCallerPeerMachine] sending offer", offer)
      await supabase
        .from("web_rtc_signals")
        .insert({
          from_user_id: currentUser.id,
          to_user_id: remoteUserId,
          payload: offer as unknown as Json,
        })
        .then(({ error }) => {
          if (error)
            logger.error(
              "[connectCallerPeerMachine] error sending offer",
              error,
            )
          else logger.info("[connectCallerPeerMachine] offer sent")
        })
    },
    sendIceCandidate: async (
      { context: { currentUser, remoteUserId, supabase } },
      candidate: RTCIceCandidate,
    ) => {
      logger.info("[connectCallerPeerMachine] sending ice candidate", candidate)
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
          else logger.info("[connectCallerPeerMachine] ice candidate sent")
        })
    },
    savePendingIceCandidate: assign({
      pendingIceCandidates: (
        { context: { pendingIceCandidates } },
        candidate: RTCIceCandidate,
      ) => [...pendingIceCandidates, candidate],
    }),
    sendPendingIceCandidates: assign({
      pendingIceCandidates: ({
        context: { pendingIceCandidates, supabase, remoteUserId, currentUser },
      }) => {
        logger.info(
          "[connectCallerPeerMachine] sending pending ice candidates",
          pendingIceCandidates.length,
        )
        supabase
          .from("web_rtc_signals")
          .insert(
            pendingIceCandidates.map((candidate) => ({
              from_user_id: currentUser.id,
              to_user_id: remoteUserId,
              payload: candidate as unknown as Json,
            })),
          )
          .then(({ error }) => {
            if (error)
              logger.error(
                "[connectCallerPeerMachine] sendPendingIceCandidates error",
                error,
              )
            else
              logger.info(
                "[connectCallerPeerMachine] pending ice candidates sent",
              )
          })

        return []
      },
    }),
  },
  actors: {
    cleanUpSignalingRows: cleanUpSignalingRowsActor,
    connectPeer,
    webRtcSignals,
  },
  guards: {
    hasOffer: ({ context }) => context.offer !== undefined,
    hasAnswer: ({ context }) => context.answer !== undefined,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcC0ADmGAE6x7ICGANtaQMSwCWU6NsAdE8mBZehCYRKOMAG0ADAF1EoAqmY4mGWSAAeiAOwBWAJwdNAFgBMpgBwA2CQGZtmzWYA0IAJ6IAjBLMdD26xMMAw2DjbXdNAF8I5zRMbHwiUnIqWgZmVnYOflgAd1JJGSQQeUVldFUNBAdrDm0LC2DDXQkws1tnNwQLXW8zd2NrawH-L11dKJiMLFxCYjI+VJJ6RJIKKfiyjgg4ZBImAiUMAtUSpkPyosrNa0MOL2MJTXrA92t6jo9jCZBY6YS55I0OhLFZrOK4TawACuyB4sFgADModRjkVTucKlpNB8ENZNMYfCYjDdjPZHmZtN9fvFZkkFsDlnMwX9NtxeFQBEIROJpCcFGcypiqsZbm0xgELDpbDocVYCbZdMZdO4zBTnmYqesZitAYsODlKAL0FAAAQI1AkE3ZPJLVFyfkYy6fV4cSXGdyGazudy6QwepyuRCGSWuxUWax9TTKwZmQya8H-OkpYEcZB0fhMY0mqEEE0EEhgABuyihsCtOFEAFsDrB6BAMGAuOhC6gANaNtNgfgAVQIAGUWGxqJmoAAlVA5WB24oOwVOhCGewcMYrvw3CzaULYwML+rLkwb3ThyVmZXxv60+bJ0gcWBgCsjk0FyuoURW9C5Big6kQjBcHh8JywiiNO6JzqAlSvCGviaCq9gWP0ATaDiNyaD4EgIboRimH4koWOeNI6vSN67F2ShZqgCIIgwoGzio86qhYBh2LGPRWDYxgWDijQGO4Vj2GE7jaDYkpRNEIDoKg2zwEUP6JleQKkHypT0RBiBKjiKpMc0mESAMzQOOM4lyZeuopgaRqmualrWkpaJ0RcakIJ4oQcNYPTaJ6uibrYAadMG2j7pxi5mE8HnWAR2oAsRJBbA2ykCqp6hBkuK5jGuAVbihhjeD6pKBFKsZNJF8lmSR6boI+OZ5gWxaoKW5ZVjWCWOk59jcUMQX1KEbyhZx+HGVqpUxbe97kaaz6vmA76fiQLXgclzlvASAzBg8sYWGY9zcTlHAUroqHurBzRxoNCamSNpEiI+lHUXN9kqY5i3XLc-rBMJEijEM3Ebl1IVhRSEViUAA */
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
      src: "webRtcSignals",
      id: "webRtcSignals",
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
        id: "cleanUpSignalingRows",
        input: ({ context }) => context,
        onDone: "creating offer",
      },
    },

    "setting remote answer": {
      entry: [
        sendTo("someActor", ({ context }) => ({
          type: "someEvent",
          data: context.answer!,
        })),
        "sendPendingIceCandidates",
      ],

      on: {
        "peer-connection.ice-candidate": {
          target: "setting remote answer",
          actions: {
            type: "sendIceCandidate",
            params: ({ event }) => event.candidate,
          },
        },
      },
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
        type: "savePendingIceCandidate",
        params: ({ event }) => event.candidate,
      },
    },
  },
})
