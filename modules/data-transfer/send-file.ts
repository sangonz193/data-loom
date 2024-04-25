import { fromCallback } from "xstate"
import { z } from "zod"

import { logger } from "@/logger"

import { fileMetadataSchema } from "./receive-file"

const CHUNK_SIZE = 1024 * 50

type Input = {
  peerConnection: RTCPeerConnection
  file: File
}

export type SendFileOutputEvent =
  | {
      type: "send-file.metadata"
      metadata: z.infer<typeof fileMetadataSchema>
    }
  | {
      type: "send-file.progress"
      sentBytes: number
    }

export const sendFile = fromCallback<{ type: "noop" }, Input>((params) => {
  const sendBack = params.sendBack as (event: SendFileOutputEvent) => void
  const { peerConnection, file } = params.input

  logger.info("[send-file] creating dataChannel")
  const dataChannel = peerConnection.createDataChannel("file")
  dataChannel.binaryType = "arraybuffer"
  dataChannel.bufferedAmountLowThreshold = CHUNK_SIZE * 5

  logger.info("[send-file] creating fileReader")
  const fileReader = new FileReader()
  let cursor = 0
  function readChunk() {
    logger.info(`[send-file] reading chunk at ${cursor} / ${file.size}`)
    fileReader.readAsArrayBuffer(file.slice(cursor, cursor + CHUNK_SIZE))
  }

  fileReader.onload = (e) => {
    logger.info(`[send-file] loaded chunk at ${cursor} / ${file.size}`)
    cursor += CHUNK_SIZE
    const chunk = e.target?.result as ArrayBuffer

    logger.info(
      `[send-file] sending chunk ${Math.min(cursor, file.size)} / ${file.size}`,
    )
    dataChannel.send(chunk)
    sendBack({ type: "send-file.progress", sentBytes: cursor })

    if (cursor >= file.size) {
      return
    } else if (
      dataChannel.bufferedAmount <= dataChannel.bufferedAmountLowThreshold
    ) {
      readChunk()
    }
  }

  dataChannel.onopen = () => {
    logger.info("[send-file] dataChannel.onopen")
    const metadata: z.infer<typeof fileMetadataSchema> = {
      name: file.name,
      size: file.size,
      mimeType: file.type,
    }
    logger.info("[send-file] sending metadata", metadata)
    dataChannel.send(JSON.stringify(metadata))
    sendBack({ type: "send-file.metadata", metadata })
    readChunk()
  }

  if (dataChannel.readyState === "open") {
    dataChannel.onopen(null as any)
  }

  dataChannel.onbufferedamountlow = () => {
    logger.info("[send-file] dataChannel.onbufferedamountlow")
    readChunk()
  }

  return () => {
    logger.info("[send-file] closing dataChannel")
    dataChannel.close()
  }
})
