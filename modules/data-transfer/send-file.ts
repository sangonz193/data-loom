import { and, assign, fromCallback, not, setup } from "xstate"
import { z } from "zod"

import { logger } from "@/logger"

import { fileMetadataSchema } from "./receive-file"

const CHUNK_SIZE = 1024 * 50

type Input = {
  peerConnection: RTCPeerConnection
  file: File
  index: number
}

type Event =
  | {
      type: "read-chunk"
    }
  | {
      type: "chunk-read"
      chunk: ArrayBuffer
    }
  | { type: "bufferedamountlow" }
  | { type: "datachannel.close" }

interface Context extends Input {
  dataChannel: RTCDataChannel
  readerCursor: number
  fileReader: FileReader
  lastChunk?: ArrayBuffer
}

export const sendFileActor = setup({
  types: {
    input: {} as Input,
    context: {} as Context,
    events: {} as Event,
  },

  actions: {
    createDataChannel: assign({
      dataChannel: ({ context: { peerConnection, file, index }, self }) => {
        logger.info("[send-file] Creating data channel")
        const dataChannel = peerConnection.createDataChannel("file:" + index)
        dataChannel.binaryType = "arraybuffer"
        dataChannel.bufferedAmountLowThreshold = CHUNK_SIZE * 5

        dataChannel.onopen = () => {
          logger.info("[send-file] dataChannel.onopen")
          const metadata: z.infer<typeof fileMetadataSchema> = {
            name: file.name,
            size: file.size,
            mimeType: file.type,
          }
          logger.info("[send-file] sending metadata", metadata)
          dataChannel.send(JSON.stringify(metadata))
          self.send({ type: "read-chunk" })
        }

        dataChannel.onbufferedamountlow = () => {
          self.send({ type: "bufferedamountlow" })
        }

        return dataChannel
      },
    }),

    createFileReader: assign({
      fileReader: ({ self }) => {
        const fileReader = new FileReader()
        fileReader.onload = (event) => {
          const chunk = event.target!.result as ArrayBuffer
          logger.info("[send-file] read chunk", chunk.byteLength)

          if (self.getSnapshot().value !== "reading chunk") {
            logger.error("Unexpected chunk read", self.getSnapshot().value)
          }

          self.send({ type: "chunk-read", chunk })
        }

        return fileReader
      },
    }),

    readChunk: ({ context: { fileReader, file, readerCursor } }) => {
      fileReader.readAsArrayBuffer(
        file.slice(readerCursor, readerCursor + CHUNK_SIZE),
      )
    },

    setLastChunk: assign({
      lastChunk: (_, chunk: ArrayBuffer) => chunk,
    }),

    sendChunk: (
      { context: { dataChannel, file, readerCursor } },
      chunk: ArrayBuffer,
    ) => {
      logger.info(
        "[send-file] sending chunk",
        chunk.byteLength,
        `${readerCursor}/${file.size}`,
      )
      dataChannel.send(chunk)
    },

    updateCursor: assign({
      readerCursor: ({ context: { readerCursor, file } }, chunkSize: number) =>
        Math.min(readerCursor + chunkSize, file.size),
    }),
  },

  actors: {
    closeDataChannel: fromCallback<{ type: "noop" }, Context>(
      ({ input: { dataChannel } }) => {
        return () => {
          logger.info("[send-file] closing dataChannel")
          dataChannel?.close()
        }
      },
    ),
  },

  guards: {
    bufferHasSpace: ({ context: { dataChannel } }) =>
      dataChannel.bufferedAmount <= dataChannel.bufferedAmountLowThreshold,
    moreToRead: ({ context: { readerCursor, file } }) =>
      readerCursor < file.size,
  },
}).createMachine({
  id: "send-file",

  invoke: {
    src: "closeDataChannel",
    input: ({ context }) => context,
  },

  context: ({ input }) => ({
    ...input,
    dataChannel: undefined as any,
    fileReader: undefined as any,
    sentBytes: 0,
    readerCursor: 0,
  }),

  initial: "init",

  states: {
    init: {
      entry: [
        {
          type: "createDataChannel",
        },
        {
          type: "createFileReader",
        },
      ],

      on: {
        "read-chunk": "reading chunk",
      },
    },

    "reading chunk": {
      entry: {
        type: "readChunk",
      },
      on: {
        "chunk-read": {
          actions: [
            {
              type: "setLastChunk",
              params: ({ event }) => event.chunk,
            },
          ],

          target: "sending chunk",
        },
      },
    },

    "sending chunk": {
      entry: [
        {
          type: "sendChunk",
          params: ({ context }) => context.lastChunk!,
        },
        {
          type: "updateCursor",
          params: ({ context }) => context.lastChunk!.byteLength,
        },
      ],

      always: [
        {
          target: "reading chunk",
          guard: and(["moreToRead", "bufferHasSpace"]),
        },
        {
          target: "#send-file.waiting for datachannel to close",
          guard: not("moreToRead"),
        },
        {
          target: "waiting for buffer",
        },
      ],
    },

    "waiting for buffer": {
      on: {
        bufferedamountlow: {
          target: "reading chunk",
          actions: () => {
            logger.info("[send-file] bufferedamountlow")
          },
        },
      },
    },

    "waiting for datachannel to close": {
      entry: ({ context, self }) => {
        context.dataChannel.onclose = () => {
          self.send({ type: "datachannel.close" })
        }
      },
      on: {
        "datachannel.close": "done",
      },
    },

    done: {
      type: "final",
    },
  },
})
