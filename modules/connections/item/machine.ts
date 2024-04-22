import { User } from "@supabase/supabase-js"
import { assign, enqueueActions, fromPromise, setup } from "xstate"
import { z } from "zod"

import { Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

import {
  ReceiveFileOutputEvent,
  fileMetadataSchema,
  receiveFile,
} from "./receive-file"
import { connectCallerPeerMachine } from "../connect-caller-peer"
import { connectReceiverPeerMachine } from "../connect-receiver-peer"
import {
  ListenToFileRequestResponseTableOutputEvent,
  listenToFileRequestResponseTable,
} from "../file-sharing-requests/listen-to-file-request-response-table"
import { requestPayloadSchema } from "../file-sharing-requests/payload"
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
  fileSharingState?: {
    metadata: z.infer<typeof fileMetadataSchema>
    transferredBytes: number
  }
  request?: Tables<"file_sharing_request">
}

type Event =
  | PeerConnectionEventsOutputEvents
  | ReceiveFileOutputEvent
  | SendFileOutputEvent
  | ListenToFileRequestResponseTableOutputEvent
  | { type: "send-file"; file: File }
  | {
      type: "connection-request-received"
      request: Tables<"file_sharing_request">
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
      listenToFileRequestResponseTable: "listenToFileRequestResponseTable"
    },
  },
  actions: {
    createPeerConnection: enqueueActions(({ enqueue }) => {
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          {
            urls: [
              "stun:stun1.l.google.com:19302",
              "stun:stun3.l.google.com:19302",
            ],
          },
        ],
      })
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
    setRequest: assign({
      request: (_, request: Tables<"file_sharing_request">) => request,
    }),
    sendResponse: ({ context }, accept: boolean) => {
      sendResponse({ accept, context })
    },
  },
  actors: {
    connectCallerPeerMachine,
    connectReceiverPeerMachine,
    sendFile,
    peerConnectionEvents,
    receiveFile,
    listenToFileRequestResponseTable,
    sendRequest: fromPromise<Tables<"file_sharing_request">, Context>(
      async ({
        input: { supabase, remoteUserId, currentUser, fileToSend },
      }) => {
        if (!fileToSend) throw new Error("File to send is not defined")

        const { data, error } = await supabase
          .from("file_sharing_request")
          .insert({
            from_user_id: currentUser.id,
            to_user_id: remoteUserId,
            payload: {
              file: {
                name: fileToSend.name,
                size: fileToSend.size,
                mimeType: fileToSend.type,
              },
            } satisfies z.input<typeof requestPayloadSchema>,
          })
          .select()
          .single()

        if (error) throw error
        return data
      },
    ),
    sendResponse: fromPromise(
      async ({
        input: { accept, context },
      }: {
        input: { context: Context; accept: boolean }
      }) => sendResponse({ context, accept }),
    ),
  },
  guards: {
    isFileDataChannel: (_, dataChannel: RTCDataChannel) =>
      dataChannel.label === "file",
    accepted: (_, event: ListenToFileRequestResponseTableOutputEvent) =>
      event.response.accepted,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcCWGAdHhADZgDEsY6EAtAGZ7kDaADALqKgAOqsefBm4gAHogBMAZgkAOQgFYAjAoAsANgDsUzQE5Vq6QBoQAT0SyFbRQtmbNsy7seWAvq5NpM2IemJlKLyxcAnQ6ACcwAEcAVzgcCOwwPAA3SHYuJBA+AV8RcQRpOUUVDW09A2MzRE0JTUIVCQVtKTYNWV1dd08MYN9-cgpkcgBDcMZmMDoAWzAcEYgR+YyRHMFQ-Mk2TVVCdXUpXQddBSkrCRNzBH3rRtUlTXUFZ10pKW6QIJ9Qwi+Q9CgFAgGDAxHQKVQAGtQX8cABhEakcjhAAKYDA4QAsiNkAALPBYFZZNZ5LIFJQPBSECRKWRadSqTS2VQKS6SRyEWQSCS6JT7JQ8qSGBQfWE-ai0AlQAAETEGPHR4V+vW+GFg8xw2FxIwBYCJvH462EZMQDykSkInU6pwF6iUqk6bIQrQkhFUbAObCK9xUUnUopVISIEogUtlkyoNHoctBs3mi2WnFWhtJoHJjN2dvNUi5EkM2nUToe9ROrV00gUB002wD3iDfhDYZjkdoE3IhB44VQUEisFg+uyKY2JoQ9tkFu2bHtTXtZyFTvHbqtznNGkO49rfR+ndQ0x4+AB0pi1HC0pwqGlOOQYH30rFGAoV5vOAHJOHack5fqykrNPH+x5J1agtSteVAuQjjqTdVT8Hc9wPGVjwxM8LyfW973QIFsFIAk9STYkh2ND9CiFdRCDOXk9G2P9TiddQ2CkQgdjtZwmieWl3g8T5A36MVDwAd0EXE70RZEKAVDFCATHFtW8UhX0I9BNmdd15BkD1Oj5BwuSdFkqS9O1aR2HQHlkaD60ISJr1SJsIys5I0jbUFgUJfCDVyd8xFNbQLWXG0JDtB1dCdZ55CZJpxynWQ2F0dQui4jDLKSGzD2bezUimGNCDjBYlhGBSPKIrzRwzPYlGzXN8z9XTFwot4mh2OolHino636dKUlswYOsyyYOy7Hs4H7NzB0KpSRzHCdq2nZRVDnVQnRzXZdA9aRLBkNQlHM-pG0PSJYniIEQTBCFoUIEMACVojidUCqNcbiLzFQGk0Wk2DYZp3QeJ0jkY2KHVkAwVDYOxONarciH4kZ1lS1BT17Ph0GoCgY0SA71USWBEeoO7U2KypLWXBjXgUCQGKdALdlIuaGTNBk5u2n4oZhmUGDh6UEbVShUf2m6Ek5pG9SUTJ3Pu5SCeXFbDjOMmpCAww3T0AVopzWLuUZog0IQjnrsOlzQQJU6YR4n4tbDXn4gQQ3UGQJZQgyXHPIKIUQfIsm4t5LRHAuaoECZXRFG5P1pEah0JHcLj0FQCA4BEDDkzG5S6ELX3k8Id6M8zzOGQ1vwSHIBOxZHGlnk5Q5q3UOQWR2TQgLtPYPvUcdmpZI5c+VNqpULvGCnsAO-yb+iuRkRkKbUTluVimL9GaGL-QSk3gyjLqwG7p3TQ0XZAeYvlyrabYKb0N0PTOWxeW2BmF87og4P3MMkNPc9L2Qa90MXh7RqLx76KpGkQb9TSMVZBAVsIHaQDpKynAAu3PiMpBI4GErbJEGI15FWduUcizgXCxW0KyX21Z5CvBWvoZqU47RmSvhDPwHUV6oI-umKw1JDAgwCs0JkTIQpck5AKQw-J6JegoeDGC51l57V1uqOhykAofWpEof+Hs5HOB+pWQODopwnA+rFeeQiLLM21mzeGcBsarwIonEchggJnDdAoSBAVd5N0Edxa+fgzZiPRjgSRI5zR0nIloAw5Y5CzUsfpIOHFLCyBzBQ9wQA */
  id: "connection",

  initial: "idle",

  context: ({ input }) => ({
    ...input,
  }),

  states: {
    idle: {
      on: {
        "send-file": {
          target: "sending request",

          actions: [
            { type: "setFileToContext", params: ({ event }) => event.file },
            {
              type: "setFileMetadataToContext",
              params: ({ event }) => ({
                name: event.file.name,
                size: event.file.size,
                mimeType: event.file.type,
              }),
            },
          ],
        },

        "connection-request-received": {
          target: "prompting user to accept connection",
          actions: [
            {
              type: "setRequest",
              params: ({ event }) => event.request,
            },
          ],
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
          target: "accepting request",
          actions: [
            "createPeerConnection",
            {
              type: "setFileMetadataToContext",
              params: ({ context }) =>
                (
                  context.request!.payload as z.infer<
                    typeof requestPayloadSchema
                  >
                ).file,
            },
          ],
        },
        decline: {
          target: "idle",
          actions: [
            {
              type: "sendResponse",
              params: false,
            },
            "clearFileMetadataFromContext",
          ],
        },
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

    "sending request": {
      invoke: {
        src: "sendRequest",
        id: "sendRequest",

        input: ({ context }) => context,

        onDone: {
          target: "waiting for response",
          actions: {
            type: "setRequest",
            params: ({ event }) => event.output,
          },
        },
      },
    },

    "waiting for response": {
      invoke: {
        src: "listenToFileRequestResponseTable",
        id: "listenToFileRequestResponseTable",

        input: ({ context }) => ({
          supabase: context.supabase,
          requestId: context.request!.id,
        }),
      },

      on: {
        "file-request-response": [
          {
            target: "connecting",
            actions: "createPeerConnection",
            guard: { type: "accepted", params: ({ event }) => event },
          },
          {
            target: "idle",
            actions: "clearFileMetadataFromContext",
          },
        ],
      },
    },

    "accepting request": {
      invoke: {
        src: "sendResponse",
        onDone: "connecting with caller",
        input: ({ context }) => ({ context, accept: true }),
      },
    },
  },
})

async function sendResponse({
  accept,
  context,
}: {
  context: Context
  accept: boolean
}) {
  const { supabase, request } = context

  const { data, error } = await supabase
    .from("file_sharing_request_response")
    .insert({
      request_id: request!.id,
      accepted: accept,
    })

  if (error) throw error
  return data
}
