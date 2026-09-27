import type { User } from "@supabase/supabase-js"
import { TRPCClientError, type TRPCClient } from "@trpc/client"
import {
  type ActorRefFrom,
  and,
  assign,
  enqueueActions,
  fromPromise,
  or,
  setup,
  stateIn,
} from "xstate"
import { z } from "zod"

import { logger } from "@/logger"
import type { AppRouter } from "@/modules/api/router"
import type { Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

import { receiveFileActor } from "../../data-transfer/receive-file"
import { sendFileActor } from "../../data-transfer/send-file"
import type { CallerOutputEvent } from "../connect-caller-peer"
import { connectCallerPeerMachine } from "../connect-caller-peer"
import type { ReceiverOutputEvent } from "../connect-receiver-peer"
import { connectReceiverPeerMachine } from "../connect-receiver-peer"
import type { ListenToFileRequestResponseTableOutputEvent } from "../file-sharing-requests/listen-to-file-request-response-table"
import { listenToFileRequestResponseTable } from "../file-sharing-requests/listen-to-file-request-response-table"
import { requestPayloadSchema } from "../file-sharing-requests/payload"
import type { PeerConnectionEventsOutputEvents } from "../peer-connection-events"
import { peerConnectionEvents } from "../peer-connection-events"

type Input = {
  currentUser: User
  remoteUserId: string
  deviceId: string
  supabase: ReturnType<typeof createClient>
  trpcClient: TRPCClient<AppRouter>
}

interface Context extends Input {
  remoteDeviceId?: string
  filesToSend?: File[]
  requestId?: string
  requestPayload?: z.input<typeof requestPayloadSchema>
  peerConnection?: RTCPeerConnection
  dataChannels?: RTCDataChannel[]
  receiveFileRefs?: ActorRefFrom<typeof receiveFileActor>[]
  sendFileRefs?: ActorRefFrom<typeof sendFileActor>[]
  request?: Tables<"share_requests">
  accepting?: boolean
  responseAccepted?: boolean
  watchFailed?: boolean
}

type Event =
  | CallerOutputEvent
  | ReceiverOutputEvent
  | PeerConnectionEventsOutputEvents
  | ListenToFileRequestResponseTableOutputEvent
  | { type: "send-files"; files: File[] }
  | { type: "receive-file.done" }
  | { type: "send-file.done" }
  | { type: "send-more" }
  | {
      type: "connection-request-received"
      request: Tables<"share_requests">
    }
  | { type: "accept" }
  | { type: "decline" }
  | { type: "retry" }
  | { type: "cancel" }
  | { type: "retry-watcher" }
  | { type: "dismiss-watcher" }
  | { type: "dismiss-error" }
  | { type: "clear-last-transfer" }

export const connectionMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as Input,
    children: {} as {
      peerConnectionEvents: "peerConnectionEvents"
      connectCallerPeerMachine: "connectCallerPeerMachine"
      connectReceiverPeerMachine: "connectReceiverPeerMachine"
      listenToFileRequestResponseTable: "listenToFileRequestResponseTable"
    },
  },
  actions: {
    stopWatchingRequest: enqueueActions(({ enqueue }) => {
      enqueue.stopChild("listenToFileRequestResponseTable")
      enqueue.assign({ watchFailed: false })
    }),
    watchRequest: enqueueActions(({ context, enqueue }) => {
      enqueue.stopChild("listenToFileRequestResponseTable")
      enqueue.assign({ watchFailed: false })
      enqueue.spawnChild("listenToFileRequestResponseTable", {
        id: "listenToFileRequestResponseTable",
        input: { supabase: context.supabase, requestId: context.request!.id },
      })
    }),
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
    setFilesToContext: assign({
      filesToSend: (_, files: File[]) => files,
      requestId: () => crypto.randomUUID(),
      requestPayload: (_, files: File[]) => ({
        files: files.map((file) => ({
          name: file.name,
          size: file.size,
          mimeType: file.type,
        })),
      }),
    }),
    setDataChannelToContext: assign({
      dataChannels: (
        { context: { dataChannels } },
        channel: RTCDataChannel,
      ) => [...(dataChannels ?? []), channel],
    }),
    closePeerConnection: enqueueActions(({ enqueue, context }) => {
      enqueue.stopChild("peerConnectionEvents")
      logger.info("[connectionMachine] Closing peer connection")
      context.peerConnection?.close()
      enqueue.assign({ peerConnection: undefined })
    }),
    setRequest: assign({
      request: (_, request: Tables<"share_requests">) => request,
    }),
    clearLastTransfer: assign({
      receiveFileRefs: undefined,
      sendFileRefs: undefined,
      filesToSend: undefined,
      requestId: undefined,
      requestPayload: undefined,
      request: undefined,
      remoteDeviceId: undefined,
      accepting: undefined,
      responseAccepted: undefined,
      watchFailed: undefined,
      dataChannels: undefined,
    }),
    spawnNextReceiveFile: assign({
      receiveFileRefs: ({ spawn, context, self }) => {
        const nextIndex = context.receiveFileRefs?.length ?? 0
        const dataChannel = context.dataChannels?.[nextIndex]

        if (!dataChannel) {
          throw new Error("No data channel available to receive")
        }

        const ref = spawn("receiveFile", {
          input: {
            dataChannel,
          },
        })

        ref.subscribe(({ status }) => {
          if (status === "done") {
            self.send({ type: "receive-file.done" })
          }
        })

        return [...(context.receiveFileRefs || []), ref]
      },
    }),
    spawnNextSendFile: assign({
      sendFileRefs: ({ spawn, context, self }) => {
        const nextIndex = context.sendFileRefs?.length ?? 0
        const nextFile = context.filesToSend?.[nextIndex]

        if (!nextFile) throw new Error("No file available to send")
        const ref = spawn("sendFile", {
          input: {
            file: nextFile,
            peerConnection: context.peerConnection!,
            index: nextIndex,
          },
        })

        ref.subscribe(({ status }) => {
          if (status === "done") {
            self.send({ type: "send-file.done" })
          }
        })

        return [...(context.sendFileRefs || []), ref]
      },
    }),
    stopReceiveFile: enqueueActions(({ context, enqueue }) => {
      const latestRef =
        context.receiveFileRefs?.[context.receiveFileRefs.length - 1]
      if (latestRef) enqueue.stopChild(latestRef)
    }),
    stopSendFile: enqueueActions(({ context, enqueue }) => {
      const latestRef = context.sendFileRefs?.[context.sendFileRefs.length - 1]
      if (latestRef) enqueue.stopChild(latestRef)
    }),
    closeDataChannel: ({ context }) => {
      const latestChannel =
        context.dataChannels?.[context.dataChannels.length - 1]

      latestChannel?.close()
    },
  },
  actors: {
    connectCallerPeerMachine,
    connectReceiverPeerMachine,
    sendFile: sendFileActor,
    peerConnectionEvents,
    receiveFile: receiveFileActor,
    listenToFileRequestResponseTable,
    sendRequest: fromPromise<Tables<"share_requests">, Context>(
      async ({
        input: {
          remoteUserId,
          deviceId,
          requestId,
          requestPayload,
          trpcClient,
        },
        signal,
      }) => {
        if (!requestId || !requestPayload)
          throw new Error("Request is not defined")

        return trpcClient.shares.request.mutate(
          {
            requestId,
            deviceId,
            toPersonId: remoteUserId,
            payload: requestPayload,
          },
          { signal },
        )
      },
    ),
    sendResponse: fromPromise<
      Tables<"share_request_responses">,
      { context: Context; accept: boolean }
    >(({ input: { accept, context }, signal }) =>
      context.trpcClient.shares.respond.mutate(
        {
          requestId: context.request!.id,
          accepted: accept,
          deviceId: context.deviceId,
        },
        { signal },
      ),
    ),
    cancelRequest: fromPromise<unknown, Context>(({ input, signal }) =>
      input.trpcClient.shares.cancel.mutate(
        { requestId: input.requestId! },
        { signal },
      ),
    ),
  },
  guards: {
    watchingRequest: or([
      stateIn("waiting for response"),
      stateIn("connecting"),
      stateIn("prompting user to accept connection"),
      stateIn("receiving connection"),
      stateIn("declining request"),
      stateIn("decline failed"),
      stateIn("receiving files"),
    ]),
    watchFailed: ({ context }) => !!context.watchFailed,
    terminalShareError: (_, { error }: { error: unknown }) =>
      error instanceof TRPCClientError &&
      ["CONFLICT", "PRECONDITION_FAILED", "NOT_FOUND"].includes(
        error.data?.code,
      ),
    cancellationGone: (_, { error }: { error: unknown }) =>
      error instanceof TRPCClientError && error.data?.code === "NOT_FOUND",
    isFileDataChannel: (_, dataChannel: RTCDataChannel) =>
      dataChannel.label.startsWith("file:"),
    accepted: (
      _,
      event: Extract<
        ListenToFileRequestResponseTableOutputEvent,
        { type: "file-request-response" }
      >,
    ) =>
      event.response.accepted && event.response.accepted_by_device_id != null,
    peerConnectionIsClosed: ({ context }) =>
      context.peerConnection?.connectionState === "closed",
    peerConnectionIsDisconnected: ({ context }) =>
      context.peerConnection?.connectionState === "disconnected",
    peerConnectionIsFailed: ({ context }) =>
      context.peerConnection?.connectionState === "failed",
    sentAllFiles: ({ context: { filesToSend, sendFileRefs } }) => {
      const lastRef = sendFileRefs![sendFileRefs!.length - 1]
      return (
        !!lastRef &&
        !!filesToSend &&
        sendFileRefs!.length === filesToSend.length &&
        lastRef.getSnapshot().status === "done"
      )
    },
    receivedAllFiles: ({ context }) => {
      const { files } = context.request?.payload as z.infer<
        typeof requestPayloadSchema
      >

      const result =
        files.length === context.receiveFileRefs?.length &&
        context.receiveFileRefs.every(
          (ref) => ref.getSnapshot().status === "done",
        )

      return result
    },
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QGMD2A7dZkBcCWGAdHhADZgDEsY6EAtAGZ7mwDaADALqKgAOqsPPgw8QAD0QBGAEzSAnIXYAOAKxyAbAGYALJM1ztAdjkAaEAE9EK9esLbt66UumGXrxwF8PZtJmzD0YjJKXyxcAnQ6ACcwAEcAVzgcaOwwPAA3SA5uJBB+QQDRCQQZfUVVDR09A2MzSwQXJUI5OU1JFWkHdXZ1e00vHwwwgKDyCmRyAEMolIY2LlF8oQiixGl2bWk7Q16VFXbpdTlDJTqpOSb99WslW+0Lg37vEFD-CMJX8PQoCggMMGI6HSqAA1gDPjgAMKTUjkKIABTAYCiAFlJsgABZ4LDZRYCZYiXLFDpnBAqNqENRGFTGGlOSRKAYvIZvIhMFgAAmo6BwFF4SKiHxZ4QwsBwkxw2Axk2+YFxuSWhSJiB2tiUMn2nXUem0qlJ2nYCh0RmUmkMkkMhk00iZEPevCiqAAtrx8N8OfFqFEOThUBz0cgwK6OXaMBQA0GcPK+PilaBinJpKTHoQzWobL1pDpXLbhSMHc7XdioB6vT6-RHg6H0L9sKRsXKFgrYytlSVZAplOmqvojKYLFJnJSDexZOt7KPPM9q0K-F8SwB3IQYkMwuF8gWECAS9HSvykaN5FuE+NWJMDkonFSp9g0hyWy32XNzkbciDFjkxBJJX7-QHAsFCDfAAlOJEjFQ9FVbU8EGcUlSnYQhnDkQ0jg2dhDWfYZ3gXSZlndBhUG9GJYH4dBqAodkwBSb8xRSUjRUbHIYwKaDxEQGwmnYfQegwjDjm0FR4MkHpCAZFQlH0NQzVkLDWUCXD8JLQjiLgMiKKomjwOSEj1LlSRmKPViT3Y9syi7SpdF7WoL3sa8jkcTNH2cOSRUCSs3RLL9tN-LB-1BcE83eDyP28pIEGxYFkAlCJskg490FWMksyQwwVHYPR9gy60hIvDRDCQjoOnUK0LR0VzXxod8COYOAN2RWdsNFcVJUxGUYHi4zErbNNKQqIwlHNPYjEMUknEuAx1CUFppAOOR2gq943w-KjYCAqqVtqqgqsYWqt3+TqCW6mDeokqkTiGlQRv1Q1U3sQxTXNS1rUMRaiGWmqWHW2hNrGN9dvIfacQMvEuqSyQjGaW9bnYE5kPUUkdmaNpYZ2WGHNuN7AhiQMMl+uBCBxtJ0nxigiYyaiqKBpjQaO8HOiadUs1aSQjnuWQxtvLYsyulxNBsQSsyxwnUjxz6CfJknxbJ0XMgBgE-mBwyoJM4ojkkSkeN0PpuPPepJETDWLiuzYLVHfntGFyX8bWxTPI5FSOSwMQcAdrb+Qa7dxTa-dDrjUz1c1lDte0TRdfg5xr3JLNJANrtDCMYXVs-WXIHqwVqzFCUpXamnmzBts4IvVnNGvJxZAwnQlFh5QvGedBUAgOBRGrWn-eKOhtFJOgLkUKb5tRmRRz0YWSHINu2OKWPZE1mRpuD7jejGlpmgcloIZsTVLenIKiDtb4J9VxAWiNfYJLDpRHF1PWpFjzRCE6GlLUOCSxyT2rYC5GgcEP46A4cSk7QprT0GocU4tlbpKHuo9C0VobQ7xfPaR0Lp7aemROWf0yBAxVl3n-FWf8p5n0ICcae5ddSDTGhDRQJ9rSV37lA4W+9FzLlXLCZEv8kquHvsYfu7QNhh1aMmTQ99VDSHJAnW8U1MYIKaoED6XkwJJA4W2CGeg7CCTaGlPQUCZCkhpAoeeI4LSsyuq9GR8lCB2xWkRFODFyJgGUTBFwWxuIoT2LDLMs1JDwVQoQGwnQRKlwer0YWIV3RhTFI40yYcjazVAVA9Kxou55VDqmIqGx2is21MLeRbsWBROKPYbuIlKS8LNPNUO1xa7mLct9aqykP51PxgU4+N8GhaGoQ4Aw5IjCHDMYMRBRBrbi3gPnOmPUOmw3VGac0pdJLJP1laLi1prS9EkpaQaVtZY2xFrjKWDTx5jPbogXQGspl6EtJleZEcyh6E0INDK6xbidC2XsnZViCI2Odq7KiLSSijkQtqc0ygxGw1fhHGk1DZAaNDhDHY79OSS0gH89o6piHVxaDoPYPMEbF16CI64ElgXrBpHXDwQA */
  id: "connection",

  initial: "idle",

  context: ({ input }) => ({
    ...input,
  }),

  states: {
    idle: {
      entry: "stopWatchingRequest",
      on: {
        "send-files": {
          target: "sending request",

          actions: [
            { type: "clearLastTransfer" },
            { type: "setFilesToContext", params: ({ event }) => event.files },
          ],
        },

        "connection-request-received": {
          target: "prompting user to accept connection",
          actions: [
            "clearLastTransfer",
            {
              type: "setRequest",
              params: ({ event }) => event.request,
            },
            assign({
              remoteDeviceId: ({ event }) => event.request.from_device_id,
            }),
            "watchRequest",
          ],
        },

        "clear-last-transfer": {
          actions: "clearLastTransfer",
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
          remoteDeviceId: context.remoteDeviceId!,
        }),

        onDone: {
          target: "sending files",
        },
      },
      on: {
        cancel: "cancelling request",
        "peer-connection.failed": {
          target: "idle",
          actions: ["closePeerConnection", "clearLastTransfer"],
        },
      },
    },

    "files sent": {
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
          target: "receiving connection",
          guard: ({ context }) => !context.watchFailed,
          actions: [assign({ accepting: true }), "createPeerConnection"],
        },
        decline: {
          target: "declining request",
        },
      },
    },

    "receiving connection": {
      invoke: {
        src: "connectReceiverPeerMachine",
        id: "connectReceiverPeerMachine",

        input: ({ context }) => ({
          ...context,
          peerConnection: context.peerConnection!,
          remoteDeviceId: context.remoteDeviceId!,
        }),
      },

      initial: "waiting for signals",

      states: {
        "waiting for signals": {
          on: { "signals.ready": "accepting request" },
        },
        "accepting request": {
          after: { 15000: "acceptance failed" },
          invoke: {
            src: "sendResponse",
            onDone: {
              target: "connecting with caller",
              actions: assign({ responseAccepted: true }),
            },
            onError: [
              {
                guard: {
                  type: "terminalShareError",
                  params: ({ event }) => ({ error: event.error }),
                },
                target: "#connection.idle",
                actions: ["closePeerConnection", "clearLastTransfer"],
              },
              { target: "acceptance failed" },
            ],
            input: ({ context }) => ({ context, accept: true }),
          },
        },
        "acceptance failed": {
          on: {
            retry: "accepting request",
            "dismiss-error": {
              target: "#connection.idle",
              actions: ["closePeerConnection", "clearLastTransfer"],
            },
          },
        },
        "connecting with caller": {},
      },

      on: {
        "peer-connection.failed": {
          target: "idle",
          actions: ["closePeerConnection", "clearLastTransfer"],
        },
        "peer.datachannel": {
          target: "receiving files",

          actions: [
            assign({ responseAccepted: true }),
            {
              type: "setDataChannelToContext",
              params: ({ event }) => event.event.channel,
            },
          ],

          guard: {
            type: "isFileDataChannel",
            params: ({ event }) => event.event.channel,
          },
        },
      },
    },

    "sending request": {
      after: { 15000: "request failed" },
      invoke: {
        src: "sendRequest",
        id: "sendRequest",

        input: ({ context }) => context,

        onDone: {
          target: "waiting for response",
          actions: [
            {
              type: "setRequest",
              params: ({ event }) => event.output,
            },
            "watchRequest",
          ],
        },
        onError: [
          {
            guard: {
              type: "terminalShareError",
              params: ({ event }) => ({ error: event.error }),
            },
            target: "idle",
            actions: ["closePeerConnection", "clearLastTransfer"],
          },
          { target: "request failed" },
        ],
      },
    },

    "request failed": {
      on: {
        retry: "sending request",
        cancel: "cancelling request",
        "dismiss-error": "cancelling request",
      },
    },

    "waiting for response": {
      on: {
        cancel: "cancelling request",
        "file-request-response.failed": "request failed",
        "file-request-response": [
          {
            target: "connecting",
            actions: [
              assign({
                responseAccepted: true,
                remoteDeviceId: ({ event }) =>
                  event.response.accepted_by_device_id!,
              }),
              "createPeerConnection",
            ],
            guard: { type: "accepted", params: ({ event }) => event },
          },
          {
            target: "idle",
            actions: "clearLastTransfer",
          },
        ],
      },
    },

    "declining request": {
      after: { 15000: "decline failed" },
      invoke: {
        src: "sendResponse",
        input: ({ context }) => ({ context, accept: false }),
        onDone: { target: "idle", actions: "clearLastTransfer" },
        onError: [
          {
            guard: {
              type: "terminalShareError",
              params: ({ event }) => ({ error: event.error }),
            },
            target: "idle",
            actions: "clearLastTransfer",
          },
          { target: "decline failed" },
        ],
      },
    },

    "decline failed": {
      on: {
        retry: "declining request",
        "dismiss-error": { target: "idle", actions: "clearLastTransfer" },
      },
    },

    "cancelling request": {
      entry: ["closePeerConnection", "stopWatchingRequest"],
      after: { 15000: "cancellation failed" },
      invoke: {
        src: "cancelRequest",
        input: ({ context }) => context,
        onDone: { target: "idle", actions: "clearLastTransfer" },
        onError: [
          {
            guard: {
              type: "cancellationGone",
              params: ({ event }) => ({ error: event.error }),
            },
            target: "idle",
            actions: "clearLastTransfer",
          },
          { target: "cancellation failed" },
        ],
      },
      on: { "dismiss-error": { target: "idle", actions: "clearLastTransfer" } },
    },
    "cancellation failed": {
      on: {
        retry: "cancelling request",
        "dismiss-error": { target: "idle", actions: "clearLastTransfer" },
      },
    },

    "sending files": {
      entry: "stopWatchingRequest",
      states: {
        "sending file": {
          exit: "stopSendFile",

          entry: { type: "spawnNextSendFile" },
          on: {
            "send-file.done": [
              {
                target: "#connection.files sent",
                guard: "sentAllFiles",
              },
              { target: "sending file", reenter: true },
            ],
          },
        },
      },

      initial: "sending file",

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

    "receiving files": {
      on: {
        "dismiss-watcher": {
          guard: "watchFailed",
          actions: assign({ watchFailed: false }),
        },
      },
      states: {
        "receiving file": {
          on: {
            "receive-file.done": [
              {
                target: "#connection.idle",
                actions: ["closeDataChannel", "closePeerConnection"],
                guard: "receivedAllFiles",
              },
              {
                target: "waiting for next file",
                actions: "closeDataChannel",
                reenter: true,
              },
            ],
          },

          entry: "spawnNextReceiveFile",
          exit: "stopReceiveFile",
        },

        "waiting for next file": {
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
      },

      initial: "receiving file",
    },
  },
  on: {
    "file-request.cancelled": {
      guard: ({ context, event }) => context.request?.id === event.requestId,
      target: ".idle",
      actions: ["closeDataChannel", "closePeerConnection", "clearLastTransfer"],
    },
    "file-request.expired": {
      guard: ({ context, event }) =>
        context.request?.id === event.requestId && !context.responseAccepted,
      target: ".idle",
      actions: ["closePeerConnection", "clearLastTransfer"],
    },
    "file-request-response": [
      {
        guard: ({ context, event }) =>
          !context.filesToSend &&
          context.request?.id === event.response.request_id &&
          context.accepting === true &&
          event.response.accepted &&
          event.response.accepted_by_device_id === context.deviceId,
        actions: assign({ responseAccepted: true }),
      },
      {
        guard: ({ context, event }) =>
          !context.filesToSend &&
          context.request?.id === event.response.request_id,
        target: ".idle",
        actions: [
          "closeDataChannel",
          "closePeerConnection",
          "clearLastTransfer",
        ],
      },
    ],
    "file-request-response.failed": {
      guard: "watchingRequest",
      actions: assign({ watchFailed: true }),
    },
    "retry-watcher": {
      guard: and(["watchingRequest", "watchFailed"]),
      actions: "watchRequest",
    },
    "dismiss-watcher": {
      guard: and(["watchingRequest", "watchFailed"]),
      target: ".idle",
      actions: ["closeDataChannel", "closePeerConnection", "clearLastTransfer"],
    },
  },
})
