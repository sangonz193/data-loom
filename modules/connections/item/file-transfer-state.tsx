import { useSelector } from "@xstate/react"
import { filesize } from "filesize"
import { CheckCircleIcon, FileIcon } from "lucide-react"
import { ActorRefFrom } from "xstate"
import { z } from "zod"

import { cn } from "@/lib/cn"
import {
  fileMetadataSchema,
  receiveFileActor,
} from "@/modules/data-transfer/receive-file"
import { sendFileActor } from "@/modules/data-transfer/send-file"

type Props = {
  file: z.infer<typeof fileMetadataSchema> | File
  sendActorRef: ActorRefFrom<typeof sendFileActor> | undefined
  receiveActorRef: ActorRefFrom<typeof receiveFileActor> | undefined
}

export function FileTransferState({
  file,
  sendActorRef,
  receiveActorRef,
}: Props) {
  const { fileName, fileSize } = getFileNameAndSize(file)

  const receiveFileState = useSelector(receiveActorRef, (state) => {
    if (!state) return undefined
    const {
      context: { receivedBytes, writtenBytes },
      status,
    } = state

    return {
      status,
      receivedBytes,
      writtenBytes,
    }
  })

  const sendFileState = useSelector(sendActorRef, (state) => {
    if (!state) return undefined
    const {
      context: { readerCursor },
      status,
      value,
    } = state

    return {
      status,
      value,
      readerCursor,
    }
  })

  const done =
    sendFileState?.status === "done" || receiveFileState?.status === "done"

  const transferring = (!!sendActorRef || !!receiveActorRef) && !done
  const transferredBytes =
    sendFileState?.readerCursor ?? receiveFileState?.receivedBytes ?? 0
  const Icon = done ? CheckCircleIcon : FileIcon

  return (
    <div
      className={cn(
        "relative gap-1 overflow-hidden rounded-md border",
        !sendActorRef && !receiveActorRef && "animate-pulse",
      )}
    >
      <div className="relative flex-row items-center gap-2 py-1 pl-3 pr-1">
        <div className="min-h-10 shrink grow flex-row items-center gap-2">
          <Icon className={cn("size-5", done && "text-green-500/50")} />
          <span className="shrink truncate text-sm" title={fileName}>
            {fileName}
          </span>
        </div>
      </div>

      {transferring && (
        <>
          <div className="relative mx-3 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="absolute bottom-0 left-0 top-0 rounded-full bg-green-500/80 transition-[width]"
              style={{
                width: `${transferring ? getProgressPercentage(transferredBytes, fileSize) : 0}%`,
              }}
            />
            {!!receiveFileState?.writtenBytes && (
              <div
                className="absolute bottom-0 left-0 top-0 rounded-full bg-green-500/50 transition-[width]"
                style={{
                  width: `${transferring ? getProgressPercentage(receiveFileState.writtenBytes, fileSize) : 0}%`,
                }}
              />
            )}
          </div>

          <div className="flex-row justify-between px-3 pb-2">
            <span className="text-xs">{filesize(transferredBytes)}</span>

            <span className="text-xs">{filesize(fileSize)}</span>
          </div>
        </>
      )}
    </div>
  )
}

function getProgressPercentage(
  transferredBytes: number,
  totalBytes: number,
): number {
  return (transferredBytes / totalBytes) * 100
}

function getFileNameAndSize(file: Props["file"]) {
  if (file instanceof File) {
    return {
      fileName: file.name,
      fileSize: file.size,
    }
  }

  return {
    fileName: file.name,
    fileSize: file.size,
  }
}
