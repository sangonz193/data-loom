import { User } from "@supabase/supabase-js"
import {
  ActorRefFrom,
  assign,
  enqueueActions,
  fromPromise,
  or,
  setup,
  stopChild,
} from "xstate"
import { z } from "zod"

import { Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

import { receiveFileActor } from "../../data-transfer/receive-file"
import { sendFileActor } from "../../data-transfer/send-file"
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
  receiveFileRef?: ActorRefFrom<typeof receiveFileActor>
  sendFileRef?: ActorRefFrom<typeof sendFileActor>
  request?: Tables<"file_sharing_request">
}

type Event =
  | PeerConnectionEventsOutputEvents
  | ListenToFileRequestResponseTableOutputEvent
  | { type: "send-file"; file: File }
  | { type: "receive-file.done" }
  | { type: "send-file.done" }
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
    setRequest: assign({
      request: (_, request: Tables<"file_sharing_request">) => request,
    }),
    sendResponse: ({ context }, accept: boolean) => {
      sendResponse({ accept, context })
    },
    clearRefs: assign({
      receiveFileRef: undefined,
      sendFileRef: undefined,
      fileToSend: undefined,
    }),
    spawnReceiveFile: assign({
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
    spawnSendFile: assign({
      sendFileRef: ({ spawn, context, self }) => {
        const ref = spawn("sendFile", {
          id: "sendFile",
          input: {
            file: context.fileToSend!,
            peerConnection: context.peerConnection!,
          },
        })

        ref.subscribe(({ status }) => {
          if (status === "done") {
            self.send({ type: "send-file.done" })
          }
        })

        return ref
      },
    }),
    stopReceiveFile: stopChild("receiveFile"),
    stopSendFile: stopChild("sendFile"),
  },
  actors: {
    connectCallerPeerMachine,
    connectReceiverPeerMachine,
    sendFile: sendFileActor,
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
    peerConnectionIsClosed: ({ context }) =>
      context.peerConnection?.connectionState === "closed",
    peerConnectionIsDisconnected: ({ context }) =>
      context.peerConnection?.connectionState === "disconnected",
    peerConnectionIsFailed: ({ context }) =>
      context.peerConnection?.connectionState === "failed",
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcCWGAdHhADZgDEsY6EAtAGZ7kDaADALqKgAOqsefBm4gAHogBMARgBsbQmxkSZAVgkqAHAHYNATkUAaEAE9EKgCwbC5xeoC+do2kzYh6YmUrOsuAujoATmAAjgCucDiB2GB4AG6Q7FxIIHwCbiLiCNJyCkqq6tp6hiaI5ipShLoqAMxS9o4g3q5+HuQUyOQAhgFRDLCJIqmCfhmSbNXyZdUSWlqaOvoyRqYI1VoV5lqqSioOThg+boRNvuhQFBAYYMTosagA1tcnOADCnaTkAQAKYGABALKdZAACzwWAGySG6WSmSkUjmhGkGg05ikKjUWmq5nMy0QcJUhF2DWeLWotDBUAABEw2jxfgFjgdmhhYDhOjhsMDOmcwBDePxhsIYXiZLotIQFlIUSotOM6ipcQg4eY9o0mb4iDwAqgALY8fBnSmhagBSk4VCUoHIMD6ykkjAUK02nB8lIC6GgTIzFS6XIzKTVJQTTaKwPVQkaapR6Mx6qq+3uLW6-UUo0ms0Wp22hMXbCkMG8ziDd0jYVZf2EeG6bSKNgWGTI0Pownx9VHEmGgDugmBdvenwodL+hAg7KBXJcpFdUNLnsQtX0lTW60DEmDWkV0gqsyxayJ+xcGvcQWtcVTNMoJ5i8UYzGul3BRchJaFc6VovFkulstq6kV2IJKQ5XqA9DlJGgIFTIIwgiC4rhuO5HkIMkIAAJRCcJWWnF90FGctzBkCUpV0KMgPrRsSgQdYKjYLRdAbOZW0PI5O06YZDQYVBTSCWA+HQagKAvKIYNZKJeJZQskn5NJZzEUpzHDNglPGOt4RlDQpEVXQaLXBTGOJNsWlY9iqU47i4D4gShOgzDIh4yzeSkKS3Rk185IQbFFOUiZyjmHRNMomQ4UIDRbH3NVmJaLMDSpGzYIfa4wUQp5DKIaKoIwiIECS1BkHZPxEmw1zcLLBd5BI2YAyDNgQ0o6pkQUH09E0WM41VdBUAgOARATYtirwuglkowamLAogSHIPrBRKt8JDrcMVFo+jFsKRZ-y0CRKgkejtHChNGUis4po9dzZl9JENKA6pyhUJRFQ0lsDMiogUPPO9jtk2EynkCRzDXNgqh-eUtKkUbmUTbU9RitM-gzS1kGtbNUpmlzprw37AwlGVdCqORyI0UNtEa6sqkjWMwaPA6wK7Hs+w+P4PrczJrrmhQ0Q0UUpBsHZN2kQhWoF0GnrG49ojPDj3uffqyzRKMQsDOtAeAhVKOyR7QPB5CIIykScEZlGvQUwi-Jx266wIiiVhlAlvWrGV4R3FVhc14zobMyl7Ik-W8L+xVNAqUKdgpo50sNOLWW9sttobSppWRarapWMNCSa0nWocBwgA */
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
            { type: "clearRefs" },
            { type: "setFileToContext", params: ({ event }) => event.file },
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
          actions: "clearRefs",
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
      entry: {
        type: "spawnSendFile",
      },

      on: {
        "send-file.done": {
          target: "file-sent",
        },
        "peer.connectionstatechange": {
          target: "idle",
          guard: or([
            "peerConnectionIsFailed",
            "peerConnectionIsClosed",
            "peerConnectionIsDisconnected",
          ]),
        },
      },

      exit: {
        type: "stopSendFile",
      },
    },

    "file-sent": {
      on: {
        "peer.connectionstatechange": {
          target: "idle",
          guard: or([
            "peerConnectionIsFailed",
            "peerConnectionIsClosed",
            "peerConnectionIsDisconnected",
          ]),
        },
      },
    },

    "prompting user to accept connection": {
      on: {
        accept: {
          target: "accepting request",
          actions: "createPeerConnection",
        },
        decline: {
          target: "idle",
          actions: [
            {
              type: "sendResponse",
              params: false,
            },
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
      entry: {
        type: "spawnReceiveFile",
      },

      on: {
        "receive-file.done": {
          target: "idle",
          actions: "closePeerConnection",
        },
      },

      exit: {
        type: "stopReceiveFile",
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
