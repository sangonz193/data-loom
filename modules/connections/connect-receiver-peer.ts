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
  offer?: RTCSessionDescriptionInit
}

type Context = Input & {
  answer?: RTCSessionDescriptionInit
}

type Event = WebRtcSignalsOutputEvent | ConnectPeerOutputEvent

export const connectReceiverPeerMachine = setup({
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
    setAnswerToContext: assign({
      answer: (_, answer: RTCSessionDescriptionInit) => answer,
    }),
    sendAnswer: async (
      { context: { currentUser, remoteUserId, supabase } },
      answer: RTCSessionDescriptionInit,
    ) => {
      logger.info("[connectReceiverPeerMachine] sending answer", answer)
      await supabase
        .from("web_rtc_signals")
        .insert({
          from_user_id: currentUser.id,
          to_user_id: remoteUserId,
          payload: answer as unknown as Json,
        })
        .then(({ error }) => {
          if (error)
            logger.error("[connectReceiverPeerMachine] sendAnswer error", error)
          else logger.info("[connectReceiverPeerMachine] sent answer", answer)
        })
    },
    sendIceCandidate: async (
      { context: { currentUser, remoteUserId, supabase } },
      candidate: RTCIceCandidate,
    ) => {
      logger.info(
        "[connectReceiverPeerMachine] sending ice candidate",
        candidate,
      )
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
              "[connectReceiverPeerMachine] sendIceCandidate error",
              error,
            )
          else logger.info("[connectReceiverPeerMachine] sent ice candidate")
        })
    },
  },
  actors: {
    cleanUpSignalingRows: cleanUpSignalingRowsActor,
    webRtcSignals,
    connectPeer,
  },
  guards: {
    hasAnswer: ({ context }) => !!context.answer,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcC0ADmGAE6x4nZgCWAbqQMSzVToCGANrAHTXJh5kbdBGoQ2OMAG0ADAF1EoAqmY5qGRSAAeiAGwyZ3AJwBGGQCZLAdhO7dAVl1GANCACeiMwA5uAFnsAzCYm9jLeRub2RgC+0a5omNj4RKTklPx0jMysnDyoAGb5pLIKSCDKquromjoIugEB3F4BUV5W7UHtuq4edfYm3PpGATK6Jp1GMvax8RhYuITEZBRUmSQMKSSCc0lV3LAArsj8sLD5BxwlmhXUahplte09iAG+PiG65vofvr-203EQAl5sklmlVvR1pttolcHs+AIhCIxBJpPJripblUaohHLpuAYrF57L9PiYjA5nggTOYZkCdgtNuCMpCNksYSC9hA4MgSNQCHd0FcyjdBTiEPYrPZuJEDAEbPVfFYIlT-tKPuZfAEvOYpVNdHTgUlFqkVizSNxeWAJNR0FAAATCWAAd0YwqUmLFD0QXgiTSMXl8uiJQcloypvnMhkjFMjMl9UdeVkNDNBpvSNEhlo41vQtodBwI9oIlFo6gOsEdOEkAFsBbAGBAMGBeOhaKgANYt5A54QAVQIAGUWOwOPmAEqoZ2wd3lT3Y70IJWNAyrpVGKJWOwRyODRyWYby-xa2KA9CobnwMpGxlgs2Z0gYyr3UC1cwudyeLz4yafEYWEwiX6LwU1hNNlgzNZLUoG07UddAXUfEV5xfbRECsSwCSJExfBpKwAg3MIdwGBxPn6IxTCMPVk0BG9wOZB8SG4fJbWoWAAAt83tOAcDYAAjMcOK4uiFw9Z9qkXMx-D8cwTF9XwZEmf5PmIvcyPJSjqNAkETQgiELSbLAnyxVDaiVHxVwMddN23T8ECTPxRlkqVflsKjtONJl7ygntcy4wti1LctKwkWt62Mr1X3QqwI3jNTLAaSIWkVU9oiAA */
  id: "connect-peers-receiver",

  context: ({ input }) => ({
    ...input,
  }),

  invoke: [
    {
      src: "connectPeer",
      id: "connectPeer",
      input: ({ context }) => ({
        calling: false,
        peerConnection: context.peerConnection,
        offer: context.offer,
      }),
    },
    {
      src: "webRtcSignals",
      id: "webRtcSignals",
      input: ({ context }) => context,
    },
  ],

  states: {
    "creating answer": {
      always: {
        target: "finishing establishing connection",
        guard: "hasAnswer",

        actions: {
          type: "sendAnswer",
          params: ({ context }) => {
            if (!context.answer) throw new Error("No answer set in context")
            return context.answer
          },
        },
      },
    },

    "finishing establishing connection": {},

    done: {
      type: "final",
    },

    "cleaning up previous attempts": {
      invoke: {
        src: "cleanUpSignalingRows",
        id: "cleanUpSignalingRows",
        onDone: "creating answer",
        input: ({ context }) => context,
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

    "signals.offer": {
      actions: sendTo(
        "connectPeer",
        ({ event }) =>
          ({
            type: "description-received",
            description: event.offer,
          }) satisfies ConnectPeerInputEvent,
      ),
    },

    "peer-connection.successful": ".done",

    "peer-connection.ice-candidate": {
      actions: {
        type: "sendIceCandidate",
        params: ({ event }) => event.candidate,
      },
    },

    "peer-connection.description": {
      actions: {
        type: "setAnswerToContext",
        params: ({ event }) => event.description,
      },
    },
  },
})
