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
      context.writer!.close()
    },
  },

  actors: {
    initializeWriter: fromPromise<FileSystemWritableFileStream, Context>(
      async ({ input: { metadata } }) => {
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
      return !!context.metadata
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
  /** @xstate-layout N4IgpgJg5mDOIC5QCcwGMwEsBuYC0AZpgDZgB0A7gIaYAumAdlAAQED2yzAtmLVRFT4BiAXzQALKgwZhiZUVQDaABgC6iUAAc2sOpjYMNIAB6IArAEYAzGTMAmKwBYAbAHYrVs44CcdswBoQAE9EAA4LMis7O28La2czVzNvZQsAXzTA1AwcfCJSShp6JlYObl5+QSohFXUkEG1degMjUwRXaLJnP2UrOOTvK2dHQJCEC1CbZ1Do9ytXR0dQ70cMrPQsXEIScmzNxhZ8sBEqiSkZOQVao0a9Fvq2u2dnMiTu7sdlZa8R4MRPVxkCzObwJbrKOyhZSuVxrEB7XLbAoI7AHVg7SjIOhgZBkRh0EQGciMbBsADWuw2iKOZBRaJpFCxtBxeIYdAQJLYaEE+gYtWu9VuzUMD3+w0ijnmQwmymhE2cozCjjMr18lm8oTMyT6cJReQxdJKDKZLMwEFINTUNx0dxFoDa8xejjsrmhfWcFh8CV+YzcKtlrmGrgmWuWzl1VK2NMNhwxjOxuLNFsUFjqWhtwtaiA6di6PT6FgGQx92eSXTiyyWcSGkwjOSjBsj9LjJtx8eKUEJMlZpIptMj+uRTaNLYTmL0TA5DFJ3OF-KtgozvKzCGLEqlHqhctCCr+7TsykikNSlk1EJ3GUyIAYbAgcCMeqRYGtTWXotXioQeBV3l-v+VXzOFEPiwlej4MkU9JlDwfAKC+tormYvRkMqkzPMkSHeGYQyfhMETJIGwIDLKoShHWmyDpS9bNqQ8GZu+lifkhh7Sq4GoWHYIZWOR1KNtRI4FO2OJ0W+9qIL+TGhIC0yODmCTzJxdg8Q2Q78bGgmtqydAifcYnjLJn4zBEygATuHGfIM3jKZR-ZqeiGljkmz6Lq+ukmOYZihGQoIek4IImb0u5jEkgL2B0VhQp4pFsdZT62fsAnkEJbZMgcOl2u54yJHmXr2Mo-5SQEe7BiqHTOMowwhtCnmxTSEBEulK4rDYHguE8XwmfMn5vGQx5eL4HTNekl5AA */
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

      always: {
        target: "receiving file",
        guard: "isMetadataSet",
      },

      on: {
        "datachannel.data": {
          actions: {
            type: "trySetMetadata",
            params: ({ event }) => event.data,
          },
        },
      },
    },

    "receiving file": {
      states: {
        writer: {
          states: {
            init: {
              invoke: {
                src: "initializeWriter",
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
          target: "receiving file",
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
