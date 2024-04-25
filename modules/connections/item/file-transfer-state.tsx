import { useSelector } from "@xstate/react"
import { filesize } from "filesize"
import { FileIcon, XIcon } from "lucide-react"
import { Actor } from "xstate"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

import { connectionMachine } from "./machine"

type Props = {
  actor: Actor<typeof connectionMachine>
  send: Actor<typeof connectionMachine>["send"]
}

export function FileTransferState({ actor, send }: Props) {
  const state = useSelector(actor, (state) => {
    return {
      value: state.value,
      receiveFileRef: state.context.receiveFileRef,
      sendFileRef: state.context.sendFileRef,
      canClearRefs: state.can({ type: "clear-refs" }),
    }
  })

  let data:
    | {
        fileName: string
        fileSize: number
        transferredBytes: number
      }
    | undefined = undefined

  const receiveFileState = useSelector(state.receiveFileRef, (state) => {
    const context = state?.context
    if (!context?.metadata) return undefined

    return {
      fileName: context.metadata.name ?? "",
      fileSize: context.metadata.size ?? 0,
      receivedBytes: context.receivedBytes,
      writtenBytes: context.writtenBytes,
    }
  })

  const sendFileState = useSelector(state.sendFileRef, (state) => {
    const context = state?.context
    if (!context?.file) return undefined

    return {
      fileName: context.file.name ?? "",
      fileSize: context.file.size ?? 0,
      readerCursor: context.readerCursor,
    }
  })

  if (receiveFileState) {
    data = {
      ...receiveFileState,
      transferredBytes: receiveFileState.receivedBytes,
    }
  } else if (sendFileState) {
    data = {
      fileName: sendFileState.fileName,
      fileSize: sendFileState.fileSize,
      transferredBytes: sendFileState.readerCursor,
    }
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border",
        (state.value === "sending request" ||
          state.value === "waiting for response") &&
          "animate-pulse",
      )}
    >
      <div className="relative mb-1 flex-row items-center gap-2 py-1 pl-3 pr-1">
        <div className="min-h-10 shrink grow flex-row items-center gap-2">
          <FileIcon className="size-5" />
          <span className="shrink truncate" title={data?.fileName}>
            {data?.fileName}
          </span>
        </div>

        {state.canClearRefs && (
          <Button
            onClick={() => send({ type: "clear-refs" })}
            size="icon"
            variant="ghost"
          >
            <XIcon />
          </Button>
        )}
      </div>

      <div className="relative mx-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute bottom-0 left-0 top-0 rounded-full bg-green-500/80 transition-[width]"
          style={{
            width: `${data ? getProgressPercentage(data.transferredBytes, data.fileSize) : 0}%`,
          }}
        />
        {!!receiveFileState?.writtenBytes && (
          <div
            className="absolute bottom-0 left-0 top-0 rounded-full bg-green-500/50 transition-[width]"
            style={{
              width: `${data ? getProgressPercentage(receiveFileState.writtenBytes, data.fileSize) : 0}%`,
            }}
          />
        )}
      </div>

      <div className="mt-1 flex-row justify-between px-3 pb-2">
        <span className="text-xs">
          {state.value === "waiting for response" &&
            "Waiting for confirmation..."}
          {(state.value === "sending file" ||
            state.value === "receiving file") &&
            data &&
            filesize(data?.transferredBytes)}
        </span>

        <span className="text-xs">{data && filesize(data.fileSize)}</span>
      </div>
    </div>
  )
}

function getProgressPercentage(
  transferredBytes: number,
  totalBytes: number,
): number {
  return (transferredBytes / totalBytes) * 100
}
