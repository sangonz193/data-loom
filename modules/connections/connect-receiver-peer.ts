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
    listenForSignals: webRtcSignals,
    connectPeer,
  },
  guards: {
    hasAnswer: ({ context }) => !!context.answer,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcC0ADmGAE6x4nZgCWAbqQMSzVToCGANrAHTXJh5kbdBGoQ2OMAG0ADAF1EoAqmY5qGRSAAeiAKwB2GdwDM+gIxmAbJZlmAnAA5LAFgA0IAJ6IATMbPcHXTtjB2DLO0t7AF8o9zRMbHwiUnJKfjpGZlZOHlQAMzzSWQUkEGVVdXRNLwRjY0sTM29db31Q0yD9dx0EM2dvb25nGUtvOzbnSP1HGLiMLFxCYjIKKgySBmSSQXnEyu5YAFdkflhYPMOOYs1y6jUNUp79Ls9EZwiAppa24P1O2ZA8QWSWWqTW9A2Wx2CVw+z4AiEIjEEmk8huKjulU0PV0xl0Q0sDn0ljaDlsrXcNTMMgcQ1xZhCFm8ZgceIcAKBiSWKVW6Qhm2W0OB+wgcGQJGoBHu6GupVu0uxemczm45hkYXMfUJDkpiGetO8lgMIWCdgGfQ5u0WWzBfNI3HFYAk1HQUAABMJYAB3RiypQYhWPRCs-wObwyNkhYa4l41XRBbi6JwyeO6ZwOPo0y0wkE8tI0CEOjhO9Au92HAhugiUWjqQ6wD04SQAWylsAYEAwYF46FoqAA1t3OdbQbyC-bkMXhGW3RWqzW6w2JC22wgXX2hNLin6ygGsUHamTuLZdKNld8ZH9dQgk6GmlN9MM7HYZM4YrEQOhUKL4KVh7mVnzdZ0QqB5QB6MZrzqBo-GaGkrFPaIP3-blAPBCdKGdV0PXQb1SBAzEwO0RBrH8GRyPI8JDEiHVXhvI8M0NXEiXDZls2BVDbXHEhuDyF1qFgAALGc4BwNgACMOAE4TsP-fd-VAqoD0cFVjGcUxxgcSYzGmWM9AY+9mP0VizHYrkbTHdZuE7LACMDcDEBCfETzPZwLyvOj3n0Rpmlado-nGMyRzzdCeMnEsZznaswFrVB60bFccF-BTCKUhyEGea94282DIgiYxmSTdl3yAA */
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
      src: "listenForSignals",
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
