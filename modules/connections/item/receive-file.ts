import { showSaveFilePicker } from "native-file-system-adapter"
import { AnyEventObject, fromCallback } from "xstate"
import { z } from "zod"

import { logger } from "@/logger"

export type ReceiveFileOutputEvent =
  | {
      type: "receive-file.done"
    }
  | {
      type: "receive-file.metadata"
      metadata: z.infer<typeof fileMetadataSchema>
    }
  | {
      type: "receive-file.progress"
      receivedBytes: number
    }

export const fileMetadataSchema = z.object({
  name: z.string(),
  size: z.number(),
  mimeType: z.string(),
})

export const receiveFile = fromCallback<
  AnyEventObject,
  { dataChannel: RTCDataChannel }
>((params) => {
  const sendBack = params.sendBack as (event: ReceiveFileOutputEvent) => void
  const { dataChannel } = params.input

  logger.info("[receive-file] Starting to receive file")

  let metadata: z.infer<typeof fileMetadataSchema> | undefined

  let receivedBytes = 0
  const writer = createWriter()

  function messageHandler(e: RTCDataChannelEventMap["message"]) {
    if (metadata) {
      receivedBytes += e.data.byteLength
      logger.info(
        `[receive-file] Received ${receivedBytes} of ${metadata.size} bytes`,
      )
      writer.write(e.data)
      sendBack({ type: "receive-file.progress", receivedBytes })

      if (receivedBytes >= metadata.size) {
        logger.info("[receive-file] Finished receiving file")
        writer.close()
        dataChannel.close()
        sendBack({ type: "receive-file.done" })
      }

      return
    }

    try {
      const parsedData = JSON.parse(e.data)
      metadata = fileMetadataSchema.parse(parsedData)
      writer.setMetadata(metadata)
      logger.info("[receive-file] Received metadata", metadata)
      sendBack({ type: "receive-file.metadata", metadata })
    } catch (error) {
      logger.error("[receive-file] Error parsing metadata", error)
    }
  }

  dataChannel.addEventListener("message", messageHandler)

  return () => {
    dataChannel.removeEventListener("message", messageHandler)
  }
})

function createWriter() {
  let initBuffer: ArrayBuffer[] = []
  let writer: FileSystemWritableFileStream | undefined
  let close = false

  return {
    setMetadata(metadata: z.infer<typeof fileMetadataSchema>) {
      showSaveFilePicker({
        suggestedName: metadata.name,
        _preferPolyfill: true,
      }).then(async (fileHandle) => {
        writer = await fileHandle.createWritable()

        logger.info("[createWriter] Writing initial buffer")
        for (const chunk of initBuffer) {
          writer.write(chunk)
        }

        initBuffer = []
        if (close) {
          logger.info("[createWriter] Closing writer")
          writer.close()
        }
      })
    },
    write(chunk: ArrayBuffer) {
      if (!writer) {
        logger.info("[createWriter] Buffering chunk")
        initBuffer.push(chunk)
        return
      }

      logger.info("[createWriter] Writing chunk")
      writer.write(chunk)
    },
    close() {
      if (!writer) {
        logger.info("[createWriter] Setting close flag")
        close = true
        return
      }

      logger.info("[createWriter] Closing writer")
      writer.close()
    },
  }
}
