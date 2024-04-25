import { User } from "@supabase/supabase-js"
import {
  ActorRefFrom,
  assign,
  enqueueActions,
  fromPromise,
  setup,
  stopChild,
} from "xstate"
import { z } from "zod"

import { Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

import {
  fileMetadataSchema,
  receiveFileActor,
} from "../../data-transfer/receive-file"
import { SendFileOutputEvent, sendFile } from "../../data-transfer/send-file"
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

type Input = {
  currentUser: User
  remoteUserId: string
  supabase: ReturnType<typeof createClient>
}

interface Context extends Input {
  fileToSend?: File
  peerConnection?: RTCPeerConnection
  dataChannel?: RTCDataChannel
  /** @deprecated */
  fileSharingState?: {
    metadata: z.infer<typeof fileMetadataSchema>
    transferredBytes: number
  }
  receiveFileRef?: ActorRefFrom<typeof receiveFileActor>
  request?: Tables<"file_sharing_request">
}

type Event =
  | PeerConnectionEventsOutputEvents
  | SendFileOutputEvent
  | ListenToFileRequestResponseTableOutputEvent
  | { type: "send-file"; file: File }
  | { type: "receive-file.done" }
  | {
      type: "connection-request-received"
      request: Tables<"file_sharing_request">
    }
  | { type: "accept" }
  | { type: "decline" }
  | { type: "clear-refs" }

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
    clearRefs: assign({
      receiveFileRef: undefined,
    }),
  },
  actors: {
    connectCallerPeerMachine,
    connectReceiverPeerMachine,
    sendFile,
    peerConnectionEvents,
    receiveFile: receiveFileActor,
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
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcCWGAdHhADZgDEsY6EAtAGZ7kDaADALqKgAOqsefBm4gAHogBMAZgkAOQgFYAjAoAsANgDsUzQE5Vq6QBoQAT0SyFbRQtmbNsy7seWAvq5NpM2IemJlKLyxcAnQ6ACcwAEcAVzgcCOwwPAA3SHYuJBA+AV8RcQRpOUUVDW09A2MzRE0JTUIVCQVtKTYNWV1dd08MYN9-cgpkcgBDcMSGWAyRHMFQ-MkpVSlCVWcFZt02WSUlE3MEDYVCTQ0lZyb1ZVkpbpAgn1DCB5D0KAoIDDBidBTUAGtvi8cABhEakcjhAAKYDA4QAsiNkAALPBYaZZWZ5LIFXaaY4SJSyLTqVT42SqBT7SSOQiyCQSXRKdTqJSMpZNO7Ap7UWhoqAAAiYgx4sPCz16jwwsBwIxw2GRIzeYAxvH4c2EOMQSm0SkInU6CikbNZa101IQrQkqzY6itMlUuyN6i5kpCRF5EH5QuYlE9jF9hAAtmBZRA5SNVdl1djQLiyapCKzjVJ6RJDNp1BadfVdEa2LppAo7Zo2JpXd53X5Pd7hX6aPQ64QeOFUFBIrAppwZjH5lqEEpVDtCGW2IOmoOpEbVBbh2bOjdB3bnEoK30ni3UEGePg3gKYtRwgKcKgBUjkGAdwLuRgKOfLzgo1i+3HJIX6spi4SdizGRbanqxZMkBci6LU5YePcbr9Ju267oKB5wsep73leN7oB82CkGiKrdpivaaq+hRLOohBTkyehlt+RoWuobArKcrIXMW1y3JB6ESpW8ECgA7oIyLXuCkIUKKcKEOGsookqWCkE+BHoAslqqNsZESLanTMg49IWpSxxsBIrJEqcOg6rIa5Sn4kQXqkta+hQVnJGkAbkOJXxybkL5iIgbAWmw5lVoQNZ7pEsTxB8Xw-H8gKBQ2ABK0RxDK7kagp-bpioDSaESbBsM0yk6haYErLopLOAYKjbNo-n9DxIxzHuDCoEeHZ8Og1AUHWiShTKiSwK11DJbGXkIJU+oGlsUi6FOalSBaBmJiRyykjqUikss1VPLV9WCo1zVwP1lCdSFiUJC10oqkomRqh5hHDaN40TVNCgzf+hirHobKyPRHTqAyG1EKh3HHWFnxYJFAJAtBTyA96wMyggaJ-MgcqhBkg2eQUSwqTI6lMlojgSP+Ci6IoDKrdIpzpoW7iQegqAQHAIjoT2N2pURdBDhadB2KpjLnJYBZyDo-1+CQ5AsylimEsTdKTaWv0Unlmj-qySa5eoOznJSYEi5x65vBLQ0FPYJPfhrdH0g6yvVIUah0gyJUFvozQFi67FQx6Da2eL+Gs4pS6JhSjHMkorTKdbBx1CTyl2hsHRKGW63u1xG6tnB3qIUeJ5nsgF5oR7bPRn7aV0QSCc3OoGkFrIRPyM90hrCxq2-br3J7nxOACcjEJwobGOIDoOhkc4LgldoVI26W8hTVs+jnGOrJmcn65EA5NkNb6fe3fGViEOlk3bKmJXFhatjWsoY6KxsY5-cvFkxXywUJfEW+FwUBm5Xv5erVXziFcWpM1hjjzLlEqbsegpyIFtbiu0BRnTamAV+ilDD-inKsDYVwDIhw1kvCBK8-Awyft1HASD+zGmJGRLQBhCxyGUDOSeaD9LSCJKmWwqYl7uCAA */
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
            { type: "clearRefs" },
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

        "clear-refs": {
          actions: ["clearFileMetadataFromContext", "clearRefs"],
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
      entry: assign({
        receiveFileRef: ({ spawn, context, self }) => {
          const ref = spawn("receiveFile", {
            id: "receiveFile",
            input: {
              dataChannel: context.dataChannel!,
            },
          })

          ref.subscribe(({ status }) => {
            if (status === "done") {
              self.send({ type: "receive-file.done" })
            }
          })

          return ref
        },
      }),

      on: {
        "receive-file.done": {
          target: "idle",
          actions: "closePeerConnection",
        },
      },

      exit: stopChild("receiveFile"),
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
