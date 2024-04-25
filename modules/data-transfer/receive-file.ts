import { showSaveFilePicker } from "native-file-system-adapter"
import { assign, fromPromise, setup } from "xstate"
import { z } from "zod"

import { logger } from "@/logger"

type Input = {
  dataChannel: RTCDataChannel
}

type Context = Input & {
  metadata?: z.infer<typeof fileMetadataSchema>
  receivedBytes: number
  writtenBytes: number
  chunks: ArrayBuffer[]
  writer?: FileSystemWritableFileStream
}

type Event = {
  type: "datachannel.data"
  data: ArrayBuffer | string
}

export const fileMetadataSchema = z.object({
  name: z.string(),
  size: z.number(),
  mimeType: z.string(),
})

export const receiveFileActor = setup({
  types: {
    input: {} as Input,
    context: {} as Context,
    events: {} as Event,
  },

  actions: {
    setDataChannelListeners: ({ self, context }) => {
      logger.info("[receive-file] Setting data channel listener")
      context.dataChannel.onmessage = (event) => {
        self.send({ type: "datachannel.data", data: event.data })
      }
    },
    trySetMetadata: assign({
      metadata: (_, data: string | ArrayBuffer) => {
        if (typeof data !== "string") return undefined

        logger.info("[receive-file] Received metadata", data)
        const metadata = tryGetMetadata(data)
        return metadata
      },
    }),
    setWriter: assign({
      writer: (_, writer: FileSystemWritableFileStream) => writer,
    }),
    addChunk: assign({
      chunks: ({ context: { chunks } }, chunk: ArrayBuffer) => {
        return [...chunks, chunk]
      },
    }),
    updateReceivedBytes: assign({
      receivedBytes: (
        { context: { receivedBytes } },
        lastChunkBytes: number,
      ) => {
        return receivedBytes + lastChunkBytes
      },
    }),
    updateWrittenBytes: assign({
      writtenBytes: ({ context: { writtenBytes } }, lastChunkBytes: number) => {
        return writtenBytes + lastChunkBytes
      },
    }),
    unshiftChunks: assign({
      chunks: ({ context: { chunks } }) => chunks.slice(1),
    }),
    closeWriter: ({ context }) => {
      logger.info("[receive-file] Closing writer")
      context.writer!.close()
    },
  },

  actors: {
    initializeWriter: fromPromise<FileSystemWritableFileStream, Context>(
      async ({ input: { metadata } }) => {
        logger.info("[receive-file] Initializing writer")
        const fileHandle = await showSaveFilePicker({
          suggestedName: metadata!.name,
          _preferPolyfill: true,
        })

        const writer = await fileHandle.createWritable()
        return writer
      },
    ),
    writeChunk: fromPromise<void, Context>(
      async ({ input: { chunks, writer } }) => {
        logger.info("[receive-file] Writing chunk", chunks[0].byteLength)
        await writer!.write(chunks[0])
      },
    ),
  },

  guards: {
    fileReceived: ({ context }) => {
      return context.receivedBytes >= context.metadata!.size
    },
    isMetadataSet: ({ context }) => {
      const result = !!context.metadata

      return result
    },
    chunkToWrite: ({ context }) => {
      return context.chunks.length > 0
    },
    writeComplete: ({ context }) => {
      logger.info(
        "[receive-file] Write complete",
        context.writtenBytes,
        context.metadata!.size,
      )
      return context.writtenBytes >= context.metadata!.size
    },
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QCcwGMwEsBuYC0AZpgDZgB0A7gIaYAumAdlAAQED2yzAtmLVRFT4BiAXzQALKgwZhiZUVQDaABgC6iUAAc2sOpjYMNIAB6IArAEYAzGTMAmKwBYAbAHYrVs44CcdswBoQAE9EAA4LMis7O28La2czVzNvZQsAXzTA1AwcfCJSShp6JlYObl5+QSohFXUkEG1degMjUwRXBLJvZ2VHD28rVzsLZWdAkIQY5zJQ1Lc7ZRTnWbMMrPQsXEIScmzNxhZ8sBEqiSkZOQVao0a9Fvq2u2dppOcnu0dlUO8vR3HETyuMgWZzdMxvZR2WauVxrEB7XLbAoI7AHVg7SjIOhgZBkRh0EQGciMbBsADWuw2iKOZBRaJpFCxtBxeIYdAQJLYaEE+gYtWu9VuzUMDwBzkckT67mcFlmylcsrGwTCjjMZFcvks3lCZmSVnSmXhVK2NLpJQZTJZmAgpBqahuOjuItAbUG00cdlc8v1Mp8CT+yoQbjVynl4oVOrM32ccJReQxZsOGMZ2Nx1ttigsdS0juFrUQrlmXSivR+Fliqqs-wQ32UXSSMVDTyi31jxvjyON9OTltxKeKUEJMlZpIptPbSMpOVR5p7qcxeiYHIYpO5wv59sFud5+YQVnFksG+9loYjSomQzrLdSlh1kNCMbhDDYEDgRjjk4dTR3or31bw0wWDCXzhJYjgWAsAxttOHbkNQi6HGUPB8AoX5OruHwRFCPyhB4FiJFEhbVsMV4LBqoQOMoVipCC0GbLB47Tt2pBoXmv6WNWZihmQp7JJ6ThJB4j7rDBk6Mfss4FP2OKsT+LqIN43icaEQJcUkuE3qEHoGiJ9FiYm6JSb2rJ0LJ9zyQgFiOK41YUREvRcQ+EGfAM3h0dSCZdpJcHGemYBmc6JjmFGXTPNYLgpJ8+7Vkkqmeg4syeKEKluYaH6ml5SZGfO-YHAFu74UCbx+vYizeI4KkBIGCpqkMPTirKalRu5JoYhARL5b+5U2B4LhPF8vSDDF4JkFCyheL4QzdQaGRAA */
  id: "receive-file",

  context: ({ input }) => ({
    ...input,
    receivedBytes: 0,
    writtenBytes: 0,
    chunks: [],
  }),

  initial: "waiting for metadata",

  states: {
    "waiting for metadata": {
      entry: "setDataChannelListeners",

      on: {
        "datachannel.data": {
          actions: {
            type: "trySetMetadata",
            params: ({ event }) => event.data,
          },
        },
      },

      always: {
        target: "receiving file",
        guard: "isMetadataSet",
      },
    },

    "receiving file": {
      states: {
        writer: {
          states: {
            init: {
              invoke: {
                src: "initializeWriter",
                id: "initialize-writer",
                input: ({ context }) => context,
                onDone: {
                  target: "idle",
                  actions: {
                    type: "setWriter",
                    params: ({ event }) => event.output,
                  },
                },
              },
            },

            idle: {
              always: [
                {
                  target: "writing",
                  guard: "chunkToWrite",
                },
                {
                  target: "#receive-file.done",
                  guard: "writeComplete",
                  actions: "closeWriter",
                },
              ],
            },

            writing: {
              invoke: {
                src: "writeChunk",
                input: ({ context }) => context,
                onDone: {
                  target: "idle",
                  actions: [
                    {
                      type: "updateWrittenBytes",
                      params: ({ context }) => context.chunks[0].byteLength,
                    },
                    "unshiftChunks",
                  ],
                },
              },
            },
          },

          initial: "init",
        },
      },

      initial: "writer",

      on: {
        "datachannel.data": {
          actions: [
            {
              type: "addChunk",
              params: ({ event }) => event.data as ArrayBuffer,
            },
            {
              type: "updateReceivedBytes",
              params: ({ event }) => (event.data as ArrayBuffer).byteLength,
            },
          ],
        },
      },
    },

    done: {
      type: "final",
    },
  },
})

function tryGetMetadata(data: string) {
  try {
    const parsedData = JSON.parse(data)
    const metadata = fileMetadataSchema.parse(parsedData)
    return metadata
  } catch (error) {
    logger.error("[receive-file] Error parsing metadata", error)
  }

  return undefined
}
