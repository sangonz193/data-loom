import { User } from "@supabase/supabase-js"
import { assign, enqueueActions, setup } from "xstate"

import { createClient } from "@/utils/supabase/client"

import { ReceiveFileOutputEvent, receiveFile } from "./receive-file"
import { connectCallerPeerMachine } from "../connect-caller-peer"
import { connectReceiverPeerMachine } from "../connect-receiver-peer"
import {
  PeerConnectionEventsOutputEvents,
  peerConnectionEvents,
} from "../peer-connection-events"
import { sendFile } from "../send-file"

type Input = {
  currentUser: User
  remoteUserId: string
  supabase: ReturnType<typeof createClient>
}

interface Context extends Input {
  fileToSend?: File
  peerConnection?: RTCPeerConnection
  dataChannel?: RTCDataChannel
  offer?: RTCSessionDescriptionInit
}

type Event =
  | PeerConnectionEventsOutputEvents
  | ReceiveFileOutputEvent
  | {
      type: "send-file"
      file: File
    }
  | {
      type: "connection-request-received"
      offer: RTCSessionDescriptionInit
    }
  | {
      type: "accept"
    }
  | {
      type: "decline"
    }

export const connectionMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as Input,
    children: {} as {
      peerConnectionEvents: "peerConnectionEvents"
    },
  },
  actions: {
    createPeerConnection: enqueueActions(({ enqueue }) => {
      const peerConnection = new RTCPeerConnection()
      enqueue.assign({ peerConnection })

      enqueue.spawnChild("peerConnectionEvents", {
        id: "peerConnectionEvents",
        input: {
          peerConnection,
        },
      })
    }),
    setFileToContext: assign({
      fileToSend: (_, file: File) => file,
    }),
    setDataChannelToContext: assign({
      dataChannel: (_, channel: RTCDataChannel) => channel,
    }),
    closePeerConnection: enqueueActions(({ enqueue, context }) => {
      enqueue.stopChild("peerConnectionEvents")
      context.peerConnection?.close()
      enqueue.assign({ peerConnection: undefined })
    }),
    setOffer: assign({
      offer: (_, offer: RTCSessionDescriptionInit) => offer,
    }),
  },
  actors: {
    connectCallerPeerMachine,
    connectReceiverPeerMachine,
    sendFile,
    peerConnectionEvents,
    receiveFile,
  },
  guards: {
    isFileDataChannel: (_, dataChannel: RTCDataChannel) =>
      dataChannel.label === "file",
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcCWGAdHhADZgDEsY6EAtAGZ7kDaADALqKgAOqsefBm4gAHogCMANjaEALAE4lCgMxsAHACY2AVgVSVAGhABPRDoOEJAdgXWNU6yrlS5mgL7vjaTNiHpiMkofLFwCdDoAJzAARwBXOBwo7DA8ADdIdi4kED4BfxFxBGlZRWU1LV19I1NETWsdQmtNKR0dFR0JdTlO-U9vDFD-QhC-PHQoCggMMGJ0NNQAa1nRsKJV-AmEcYXkAEN-LKyRPMFwwsQGhXllbs7rOXVu4zMEGQkrFU0FXUf1NhUTn6IA24UI1Fo4ygAAImOQKDwwGBIiNBmMMLAcAdsAALPYTMDHHKnAo5IpXG5KO42P5yF6IORueTfRxsFzqOwSHTA0FEHiRVAAWx4mxhcWokWhOFQ0L2yGQYBF0N56AocoVIqJvH4Z2EZMuekpCmpDyedNqCHqsgkci+jykmi+3wkPLRawC-KFIqh0PFyKlMvVipwyrd-im2FI40JnBOOtJoCKXw+Kg6xsenTY+npls0jU0LRkbAdWh+QK8ILDYNBE2hAHdBDjlXtSORIgikSiIAc5XjfKQtbl4+d9cU5BJNFYsyplGw2Zpza8rVZbQv1A6nQoXRWVYRogr0j64ZR96kMoxmLNplhBySR4nJIzZEpHXPWnmAdYc+oPjo52xXz-aw7gUTwK3QVAIDgEQVTjfJ7zERA6CkHM6EaZQFHHDQ5AaCRMKkV1fHdQJyDg3V0AuBA3BzHRuiaJQcMdR0fxUbcBiI4YaygMiE0QqicMIL4AQA9QdDkNgJBpGjrCkQgDE0J42CcPQt1AncqyICEICPS8eIQooJCzawrFcSSlNopwJBqV4LBUQhNGkBzgPsJ4nkIoYwU9YVRV9CUA1leVg1DDiELvPUHyowErAUdptDUBpbS-C1vjsqQ8OcpQHTcCx3PRAIuPrRtm1bZE9PCvjDLsEzx0Mhp1Es6y6nsKw8P+Rw82aCS5Fy4jT0PWtjzKijR2kRlCB+Ax2htGkdBzPNZPsVjbXXYsbG3TwgA */
  id: "connection",

  initial: "idle",

  context: ({ input }) => input,

  states: {
    idle: {
      on: {
        "send-file": {
          target: "connecting",

          actions: [
            "createPeerConnection",
            { type: "setFileToContext", params: ({ event }) => event.file },
          ],

          reenter: true,
        },

        "connection-request-received": {
          target: "prompting user to accept connection",
          actions: { type: "setOffer", params: ({ event }) => event.offer },
        },
      },
    },

    connecting: {
      invoke: {
        src: "connectCallerPeerMachine",

        input: ({ context }) => ({
          ...context,
          peerConnection: context.peerConnection!,
        }),

        onDone: {
          target: "sending file",
          reenter: true,
        },
      },
    },

    "sending file": {
      invoke: {
        src: "sendFile",

        input: ({ context }) => ({
          ...context,
          peerConnection: context.peerConnection!,
          file: context.fileToSend!,
        }),
      },

      on: {
        "peer.connectionstatechange": {
          target: "idle",
          guard: ({ context }) =>
            context.peerConnection!.connectionState === "failed" ||
            context.peerConnection!.connectionState === "closed" ||
            context.peerConnection!.connectionState === "disconnected",
        },
      },
    },

    "prompting user to accept connection": {
      on: {
        accept: {
          target: "connecting with caller",
          actions: "createPeerConnection",
        },
        decline: "idle",
      },
    },

    "connecting with caller": {
      invoke: {
        src: "connectReceiverPeerMachine",

        input: ({ context }) => ({
          ...context,
          peerConnection: context.peerConnection!,
        }),
      },

      on: {
        "peer.datachannel": {
          target: "receiving file",

          actions: {
            type: "setDataChannelToContext",
            params: ({ event }) => event.event.channel,
          },

          guard: {
            type: "isFileDataChannel",
            params: ({ event }) => event.event.channel,
          },
        },
      },
    },

    "receiving file": {
      invoke: {
        src: "receiveFile",

        input: ({ context }) => ({
          dataChannel: context.dataChannel!,
        }),
      },

      on: {
        "receive-file.done": {
          target: "idle",
          reenter: true,
          actions: "closePeerConnection",
        },
      },
    },
  },
})
