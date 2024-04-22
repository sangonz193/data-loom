import { filesize } from "filesize"
import { FileIcon, XIcon } from "lucide-react"
import { Actor, StateFrom } from "xstate"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

import { connectionMachine } from "./machine"

type Props = {
  state: StateFrom<typeof connectionMachine>
  fileSharingState: NonNullable<
    StateFrom<typeof connectionMachine>["context"]["fileSharingState"]
  >
  send: Actor<typeof connectionMachine>["send"]
}

export function FileTransferState({ state, fileSharingState, send }: Props) {
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
          <span className="w-full break-words">
            {fileSharingState.metadata?.name}
          </span>
        </div>

        {state.can({ type: "clear-file-metadata" }) && (
          <Button
            onClick={() => send({ type: "clear-file-metadata" })}
            size="icon"
            variant="ghost"
          >
            <XIcon />
          </Button>
        )}
      </div>

      <div className="relative mx-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute bottom-0 left-0 top-0 bg-green-500/50 transition-[width]"
          style={{
            width: `${getProgressPercentage(fileSharingState.transferredBytes, fileSharingState.metadata.size)}%`,
          }}
        />
      </div>

      <div className="mt-1 flex-row justify-between px-3 pb-2">
        <span className="text-xs">
          {state.value === "waiting for response" &&
            "Waiting for confirmation..."}
          {(state.value === "sending file" ||
            state.value === "receiving file") &&
            filesize(fileSharingState.transferredBytes)}
        </span>

        <span className="text-xs">
          {filesize(fileSharingState.metadata.size)}
        </span>
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
