import { User } from "@supabase/supabase-js"
import { assign, enqueueActions, setup } from "xstate"
import { z } from "zod"

import { createClient } from "@/utils/supabase/client"

import {
  ReceiveFileOutputEvent,
  fileMetadataSchema,
  receiveFile,
} from "./receive-file"
import { connectCallerPeerMachine } from "../connect-caller-peer"
import { connectReceiverPeerMachine } from "../connect-receiver-peer"
import {
  PeerConnectionEventsOutputEvents,
  peerConnectionEvents,
} from "../peer-connection-events"
import { SendFileOutputEvent, sendFile } from "../send-file"

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
  fileSharingState?: {
    metadata: z.infer<typeof fileMetadataSchema>
    transferredBytes: number
  }
}

type Event =
  | PeerConnectionEventsOutputEvents
  | ReceiveFileOutputEvent
  | SendFileOutputEvent
  | {
      type: "send-file"
      file: File
    }
  | {
      type: "connection-request-received"
      offer: RTCSessionDescriptionInit
    }
  | { type: "accept" }
  | { type: "decline" }
  | { type: "clear-file-metadata" }

export const connectionMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as Input,
    children: {} as {
      peerConnectionEvents: "peerConnectionEvents"
      connectCallerPeerMachine: "connectCallerPeerMachine"
      connectReceiverPeerMachine: "connectReceiverPeerMachine"
      sendFile: "sendFile"
      receiveFile: "receiveFile"
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
    setFileMetadataToContext: assign({
      fileSharingState: (_, metadata: z.infer<typeof fileMetadataSchema>) => ({
        metadata,
        transferredBytes: 0,
      }),
    }),
    clearFileMetadataFromContext: assign({
      fileSharingState: undefined,
    }),
    updateTransferredBytes: assign({
      fileSharingState: ({ context }, transferredBytes: number) => ({
        ...context.fileSharingState!,
        transferredBytes,
      }),
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
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcCWGAdHhADZgDEsY6EAtAGZ7kDaADALqKgAOqsefBm4gAHogDMAJgCshABwyAjDIDsAFlUBOLUvmqAbABoQAT0QyDEwku0H1O+W3kTtAXzcm0mbEPTEySm8sXAJ0OgAnMABHAFc4HEjsMDwAN0h2LiQQPgE-EXEEaTlFFQ1tXX1jM0QpVTlVKQNlJTYDDX1DDy8MEL8A8gpkcgBDCMZmMDoAWzAcEYgR+cyRXMEwgsR1JUIdPf39+WrzBAcDBSkpLQ0pVy02NilukGDfMMJX0PQoCggMMGI6FSqAA1gDPjgAMIjUjkCIABTAYAiAFkRsgABZ4LArbJrfLZQqOQgydQGeSaCRKAzUiTyEwnGnqQgGNhaJoueQqJnPCHvai0bFQAAETEGPCREQ+vTeGFg8xw2AxI2+YFxvH462EhMQxNJ5Mp1Np9Jqp3UUkI5q05PZly08i0El5MtCRAFECFosmVBo9DFANm80Wy04q01BNAhSUEnUcmu9ltUjYqmjUgZW10NksSik8ic2zJEgMzp8rv8PAiqGmPHw32FsWoEWFOFQwvRyDANeFfIwFHbnZw6py4Y2OoQerJFNUVJpVhNJ1k5wMy7UOZk900qhLfXeFarNc9DeRzdb-a7PfQv2wpGxatDeJH2sjWyOLP0MjY6m2SmtelU6YQS45EuewDHuI4wMsbdZX8Pk6wAd0EDFuxhOEKAlZFCGDdFlR8Ugh3xUdnwQWxpEIKRWkULQZEsVQHnUAC6jYGx1GkCQ2TA+4qSdTwXhdfoog7NJPX9ChBJSdIJnILD-gIx90E2EjFFUQhXAcIsJCLWwUwArlLT2dcjkXVQHWgstCHE4S61EyzJP9QhAwWJYRjkvIiLEWpnDkZodE-KktDOADbB2all1ae0wLzWQzP6d0RO9d0pIBPcoCiWBYFcrUFLHJR1DYHZ7VYhxzTuCQALoi1wqpKQrSTa4YveWz4sGWypnslK0oy+8NTcp8PMA3KdmXEzyhkfR9AAulKp-Zoc0uRpWI8Xj0FQCA4BEC8w167LiLoc4HgOw7DtygC9sIQ7NJpNQY1uJ5eIvAYwC2rLFJzFTbDULloxkdiKLK01DPI+pfOcXLvwaog4KgZ6I361kLX1RRlzYdiioAsbmNZR12NaOj8qUCH-Di6zJhh9yo0u8jKPJCkJDUHR0fZFk2SaVQUw0a1i3u-jd0rataxFI8mxbNtkA7c8eb6wi+sKAxZEtWM6lyn7nGoxjHRZH8U3ZFGrE0LmelLfooeFRCcGQ5BUORMmZcQaMiyp5wadY+mtEY1lNeuGQkzUK5aMJizkiskV-Rtnb+qTGlyLza5bicGlGMaT2OfuFG6UWpagA */
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
            "clearFileMetadataFromContext",
          ],

          reenter: true,
        },

        "connection-request-received": {
          target: "prompting user to accept connection",
          actions: { type: "setOffer", params: ({ event }) => event.offer },
        },

        "clear-file-metadata": {
          actions: "clearFileMetadataFromContext",
        },
      },
    },

    connecting: {
      invoke: {
        src: "connectCallerPeerMachine",
        id: "connectCallerPeerMachine",

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
        id: "sendFile",

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

        "send-file.metadata": {
          actions: {
            type: "setFileMetadataToContext",
            params: ({ event }) => event.metadata,
          },
        },

        "send-file.progress": {
          actions: {
            type: "updateTransferredBytes",
            params: ({ event }) => event.sentBytes,
          },
        },
      },
    },

    "prompting user to accept connection": {
      on: {
        accept: {
          target: "connecting with caller",
          actions: ["createPeerConnection", "clearFileMetadataFromContext"],
        },
        decline: "idle",
      },
    },

    "connecting with caller": {
      invoke: {
        src: "connectReceiverPeerMachine",
        id: "connectReceiverPeerMachine",

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
        id: "receiveFile",

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

        "receive-file.metadata": {
          actions: {
            type: "setFileMetadataToContext",
            params: ({ event }) => event.metadata,
          },
        },

        "receive-file.progress": {
          actions: {
            type: "updateTransferredBytes",
            params: ({ event }) => event.receivedBytes,
          },
        },
      },
    },
  },
})
