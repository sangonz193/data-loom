import { SupabaseClient, User } from "@supabase/supabase-js"
import { assign, sendTo, setup, sendParent } from "xstate"

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

export type CallerOutputEvent = Extract<
  ConnectPeerOutputEvent,
  { type: "peer-connection.failed" }
>

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
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcC0ADmGAE6x7ICGANtaQMSwCWU6NsAdE8mBZehCYRKOMAG0ADAF1EoAqmY4mGWSAAeiAOwBWAJwdNAFgBMAZgmHNugGzXTpgIwAaEAE9EDiQA4Oh7Y4ldT21NUOMAX3CXNExsfCJScipaBmZWdg5+WAB3UkkZJBB5RWV0VQ0ETWtDDm1Da10vbWttL0ttbRd3BAafLwdjPwk64y9Qh0jojCxcQmIyPhSSegSSCmm40o4IOGQSJgIlDHzVYqYjssKKzVMa72MHawlNY11dQ1MujwiokBiZ+LzJI0OjLVbrWK4LawACuyB4sFgADMYdQToUzhdylpNF8EKYXr4TNYHhJHIZDLpJn8NrNVsClit5hCAVtuLwqAIhCJxNJTgpzqVsZVBhwvKY3iEmm8dMY8U9jBxTHpbg4PppAo1qf84nNEotQRxspRBegoAACJGoEjmrK5ZbouQCrFXb4OUwcayaBw2Ko6OpGPH1TSe3TGEm6CV+NXabW0wH65KG5B0fhMM3mmEEc0EEhgABuyhhsFtOFEAFtDrB6BAMGAuOh86gANb1lNgfgAVQIAGUWGxqOmoAAlVDZWCOorOoWuhCWHwSRdkjpeWzVHRB2wcd7h0ZPD6rqm-HV0oEG0gcWBgMtD8158uoUS29A5Bjgk8XLg8Phc4SiSeYjOoAVO6Xq+CEDghI02iDKueK3CGhgSCS-j+O6jwTMe8Z6gsSYXnsHZKBmqBIkiDAAdOKizl4q4GFKLRqqM2hqkGFIGI83gDB0i71JEvzoKgOzwIUH44QyoL8iUVHAYgrx4g4tG6MhDxeA8kF1IYcaQgmuEghexqmhaVo2napCSYK0nqB4EjGNoSqNIYXjPI4xg6Lom52TuJIaoM6GaFpAJieeJDbHW5kujJc6aAuS7Kq0a7tPBjkcD64amC0zRht6mlYdpQV4SF7ZphmWY5nmhaoMWpYVlW4VAVZlS4m4iAfIqXn2E0qnIelAW6vSwWXteREWvej5gM+r4kHVlkgelipmH4tkWDY7qdM1c7JdKrnvAS3rNNYvWnomemFXmIi3iRZFTRilGXJFNw1GqbSNHYNzOR527Eq5NmGH5fHhEAA */
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
      entry: "sendPendingIceCandidates",

      on: {
        "peer-connection.ice-candidate": {
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
      actions: [
        { type: "saveAnswerToContext", params: ({ event }) => event.answer },
        sendTo(
          "connectPeer",
          ({ event }) =>
            ({
              type: "description-received",
              description: event.answer,
            }) satisfies ConnectPeerInputEvent,
        ),
      ],
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

    "peer-connection.failed": {
      actions: sendParent(({ event }) => event satisfies CallerOutputEvent),
    },
  },
})
