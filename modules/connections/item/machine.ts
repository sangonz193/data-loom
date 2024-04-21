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
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcCWGAdHhADZgDEsY6EAtAGZ7kDaADALqKgAOqsefBm4gAHogBMAZgkAOQgFYAjAoDsbKaqlKAnKv0AaEAE9EszYTayJAFjYLtqhToBsCgL7ujaTNiHpiMkofLFwCdDoAJzAARwBXOBwo7DA8ADdIdi4kED4BfxFxBGk5RRV1TW09QxNEVTtCFwkdCQVZdoUFJqlPbwxQ-0DyCmRyAENIxmYwOgBbMBwxiDHFrJE8wXDCyTZ6xpcbJRsbNysdG1UjUwQXFzZCFQkXHSlD1wkJJV6QEL9wwl+YXQUAoEAwYGI6DSqAA1hDATgAMJjUjkSIABTAYEiAFkxsgABZ4LBrHIbAo5IpKJROQifWTPNxuaxSFxXSTtQjWZonHTOTpOb4I-7UWjEqAAAiYwx4WMiAP6fwwsEWOGwBLGwLApN4-E2wkpiBp2kIOjNHRcSlkdik7IQUjYEkIdia+g0yienSFirCRFFEHFUumVBo9GlEPmi2Wq046z1FNAVIuNkaSm0zzUOiUrVttQQNNUpocaYcsk6DNc3t8voC-sD4ZDtCm5EIPEiqCg0VgsB1uXjW0N+ZssiUlnUrQUEkdDqUdpHzrN5t2UheLikHi8Px9gzbqFmPHwwIlcWokQlOFQEvxyDAB4lwowFGvt5wvfJA8TkhaheUahsCjYNcLnMO1VE+RRnikEdZFUF52i+TcHwCXd90PSUT2xc9L2fO8kNBbBSGJbVYzJfsDU-YobBXRoZHOOxoMdO0DhTGk7lUEcjjXWQdCrAZ-mFI8AHdBAJe8UTRChZWxQho3xDVfFIN8yPQbZ7XowgZDYGwPlaawYLtf8FEsJ5qTYHR3WzNdeKVAJohvdJ62DOzUgyZsITBEkSN1fIPzEI0tFHRcLStG07WceQnCea1qT5ZpVGsmtCGchyjwbZLXPDQhIyWFYxiUnzyL8oc9ktdM+Vg7MHAM+d13OB0FH-W5mgSwZ0sc4Z0pmTLd07OAey8vsCpUwcjnnXY2CtD4VxKBQ7SglNzKaaK0yW2QWpFUNA2ieJElBcFIWhOFCH9AAlWIEhVfL9WGijbBUB4wLYQCbDo7jc2uVx7mHBkum01pDnixDt3+QSxk2VLUDPLs+HQagKHDZIdpVZJYBh6groTIrjidRcWleWQnpg2c8yeFNXjXepJyeT4vSB6tBhwtCJW2i6cD2rADtheFgaIRmtvOxIEGJaFkBWcIsgx3yileKwNKnP7dLkS48ycHRFA+F6qPsRcbHWohQfByUGEh5m4DRygEZZxIUfNlglGybzrtU7HTUXaRh0J1RieuVQ3GdcsXAJ45jnaTxN3QVAIDgEQkLjIbVLoNk80TywnrT9O0-XDc+np-4SHIOOncHGm1fMM1SZkOQdFAy1GnsMuyyUJldbpviiAEqBC8xop9DV+l1Amj5bjLO1-q5D4Wk6KnNHsPXa021Lpi7qWjROFNrScJ7mU0X3R9g51AKeddfbLG059bdtUMDDCzwvK9kBvXCeZuwai9uu4jM+JQNHYk47i00CbR1a2DuP+VwrIJDnw7hKYSOBRKi1RNiZehVpZaELCuMsUgsFYI0NaUCssXhZjkNoZMDJz5tUXgXUi8cRr-nuLYL+1oAJuBkGFawXJKq+2qM8L2586xHitiqZBL8ihPHsHSUymhrS3CejYO0dVLDDk6C8KcZZPjnwNkzY2UMzbKjAMI52EhQLrn9m0XQE0TjtEBjnNuAQ+YCIFkI6hb8iraAZBpFwYFPG3AdBIZWPsTGOlsC8cmzQmhh3cEAA */
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

          reenter: true,
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
          target: "accepting request",
          actions: ["createPeerConnection", "clearFileMetadataFromContext"],
          reenter: true,
        },
        decline: {
          target: "idle",
          actions: {
            type: "sendResponse",
            params: false,
          },
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
            reenter: true,
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
