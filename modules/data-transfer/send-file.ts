import { and, assign, fromCallback, not, setup } from "xstate"
import { z } from "zod"

import { logger } from "@/logger"

import { fileMetadataSchema } from "./receive-file"

const CHUNK_SIZE = 1024 * 50

type Input = {
  peerConnection: RTCPeerConnection
  file: File
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
      dataChannel: ({ context: { peerConnection, file }, self }) => {
        const dataChannel = peerConnection.createDataChannel("file")
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
            console.error("Unexpected chunk read", self.getSnapshot().value)
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
    closeFile: fromCallback<{ type: "noop" }, Context>(
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
  /** @xstate-layout N4IgpgJg5mDOIC5SzAOwgWgGYEsA2YAdDqjgC4DEATmAIaYDGAFgK6oDWA2gAwC6ioAA4B7WORzDUAkAA9EANgAcAFkIBmAEyKAjAE553DQFZuu7ooA0IAJ6I15who3yjitfOVGN27RuUBffysUdGx8Ihp6EigAAmY2dgp4jgxIiB5+JBARMTIJKSy5BAB2DV1CRXlS7mUfRXrdZStbBF9FQhNuLu1uNXddDV7A4LRMXAJCEIhouNYOCgzpHPFJaSKNYuKK4pNjV10jeUG1ZsRleXlHZyMvC9digYCgkCmwiamZ5MTObUyhURWBVA602212N0UByOvVOCAu5WKvW0-TUymKPV0wxeozeRA+qFiXwWGj+2QBeVWhUQGy2ih2hghUOOsIM5QOajaRl8tTUmOer3GRAA7rRxASYlhhFQYgAjFhYLBgKgUOUKpWQWgAW2EbDIeGEQsWWWWFKBsgUKnUWj0BmMpnMsNcqlKLguBm48ncikCz1QwggcGkAvCS3J+TWiAw8lhUaxwYmJHIody4apCGUvMI6NMul55nqXlhGw0VxcRl0xTuxR0ajjOMFhDSnzm7GTgIjCDM3EIaIuPi6hl0ig0RYrjkrhyMOz6KmcddCDfxhJbbdNHeUI5siG0aJ711cvIrFzU3v59fChBFYtikulqsVVFXqeBZ1Kjinuh6Gf2ZRZDmObRKDu1baPOYwXhAkhgE+lIvumyjOhiuZmPUiiFlucIXFmSLeEONxVMUPr+EAA */
  id: "send-file",

  invoke: {
    src: "closeFile",
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
          reenter: true,
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
          target: "done",
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

    done: {
      type: "final",
    },
  },
})
