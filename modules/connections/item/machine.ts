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
  requestId?: string
}

type Event =
  | PeerConnectionEventsOutputEvents
  | ReceiveFileOutputEvent
  | SendFileOutputEvent
  | ListenToFileRequestResponseTableOutputEvent
  | {
      type: "send-file"
      file: File
    }
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
    setRequestId: assign({
      requestId: (_, requestId: string) => requestId,
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
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcCWGAdHhADZgDEsY6EAtAGZ7kDaADALqKgAOqsefBm4gAHogBMAZgkAOQgFYAjAqlqJAFgWyFEgDQgAnoh1tFCgJxtZANiWy5G2RoC+Lg2kzYh6YmUqeWLgE6HQATmAAjgCucDjh2GB4AG6Q7FxIIHwCPiLiCNJyiipqMlo6+kaIAOwS1YQqcs42FhZSCtUWbh4YQT5+5BTI5ACGYYzMYHQAtmA4IxAj8+ki2YIheZJs1RqENjZSsjIWNtVsSmwaBsYI+2aN1Tq6bAod1d0ggd4hhF-B6FAKBAMGBiOhkqgANagv44ADCI1I5DCAAUwGAwgBZEbIAAWeCwK0ya1ymXySiU1QUhAk9lqr3OFkpNmuklk8gcUm27IsEgUGiUJw+sJ+1FoBKgAAImIMeOiwr9et8MLB5jhsLiRgCwETePx1sIyYhKVIlIRWq1tDZttoNJUblyJIQNGwbBodny2DI6lJhUrgkQxRAJdLJlQaPQZaDZvNFstOKt9aTQOT3bs7DJau7dBJLqyEJT6hZVNIlBJTho7Eo-V4A74gyGo+HaBNyIQeGFUFAIrBYLqskmNkaC04zds2HVVILZCd87IzQo2EulFz+UobLIa30fh3UNMePgAZLotQwpKcKhJTjkGAD5KRRgKNfbzh+yShynJLz6sp+abTeyboslUCC1AuLSvDsBzWu87ifP6-S7vuh5SieGLnpez53g+6BAtgpAEjqCbEoOhqfgUUiVoQ7RWCc7RUhoUj5taUiEFB1oUs01RUluyq+CKR4AO6CLi96IsiFByhihBxjimpeKQb6kegmwIJR1jUbmS6LtYRyyPmWjUhONhNI81R2JYCi8XWhARDeKSNmGdlJKkragsChLEXqOQfmIxrVKa5oWlaNrOPaiCWPIVJyBYjwWHaJk2NZ-TOQ5R5NqlrlRoQMYLEsIxKT5ZF+SOOx7CudSaNFubATco7UZZlbehu1TVnBOG2YkaVShlXVZZM7adt2cB9l5A5FSpw5KPV46TqaFgziZ+aHLsVhAZolFSMWQrtQhooRiGEQxHEQIgmCELQoQQYAEpRLEqqFQak3kZoKgNK1Fnzm67rVPmsWsSc-K0q0K4CslPyCSM6zpagZ49nw6DUBQUYJMdqoJLACPUI9yYlRodpBRapSyGwVhMSB5a7JRNgdBUFKvMW4NEJD0M9bDkrwyqlAo0d93xJziM6koGTeU9qn406FqtMTpNevm5nUlo1pLjaXIrkzvhYShHN3SdHmggSF0wntRBa4duuqgghuoMgSwhOkOO+fk6nyDIKs6eyhzy5YigSOW64HHyvJdB86CoBAcAiDhiYTapdC1YgdDUlLKdS1ISW7bW-QkOQMdi8OtI+0cxY6On2ixQnoF2HsrpLlIAWHIusE9FnPwCVAee4-k3EWDSdIyOuhx1Eo+Z8rsnIUmPTKyGcriZ9ugYHelkyd07xqVuP2bmfYuamqPnTOq6+PxSTDESBrg17geIZoWeF5XsgN7YSbz3jfnL3WtStIvPsjyB1S3t5A5lOG6BabUW4L34ntISIkxJIgxKvYqzsAr1C2g4OQtIUG-RAmceQbQ2jTVNK1C0F9MqOVziRWOU0tBmE0IXJcpwZ7FnzNoJ0846hulUJFL0F8GxHl5nERBr98jlheH3H+jD-4KD+goGwvtVBOA0AtWRGcIF8UICzbWDB2YC2oEI8W4VQLtGdAzAKtg3RbV9PPdRZt+EWxwPo4cAE5HpxaKaSw3FXTkxuAFIyfsaaUjkFOKybgXBAA */
  id: "connection",

  initial: "idle",

  context: ({ input }) => input,

  states: {
    idle: {
      on: {
        "send-file": {
          target: "sending request",

          actions: [
            { type: "setFileToContext", params: ({ event }) => event.file },
            "clearFileMetadataFromContext",
          ],
        },

        "connection-request-received": {
          target: "prompting user to accept connection",
          actions: [
            {
              type: "setRequestId",
              params: ({ event }) => event.request.id,
            },
            {
              type: "setFileMetadataToContext",
              params: ({ event }) =>
                (event.request.payload as z.infer<typeof requestPayloadSchema>)
                  .file,
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
          actions: ["createPeerConnection", "clearFileMetadataFromContext"],
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
            type: "setRequestId",
            params: ({ event }) => event.output.id,
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
          requestId: context.requestId!,
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
  const { supabase, requestId } = context

  const { data, error } = await supabase
    .from("file_sharing_request_response")
    .insert({
      request_id: requestId!,
      accepted: accept,
    })

  if (error) throw error
  return data
}
