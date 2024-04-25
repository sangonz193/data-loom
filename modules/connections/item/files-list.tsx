import { useSelector } from "@xstate/react"
import { ActorRefFrom } from "xstate"
import { z } from "zod"

import { fileMetadataSchema } from "@/modules/data-transfer/receive-file"

import { FileTransferState } from "./file-transfer-state"
import { connectionMachine } from "./machine"

type Props = {
  actor: ActorRefFrom<typeof connectionMachine>
}

export function FilesList({ actor }: Props) {
  const state = useSelector(actor, (state) => {
    const {
      context: { filesToSend, receiveFileRefs, sendFileRefs, request },
    } = state

    const transferredFiles: (File | z.infer<typeof fileMetadataSchema>)[] = []
    if (filesToSend && sendFileRefs) {
      sendFileRefs.forEach((sendActor, index) => {
        if (sendActor.getSnapshot().status === "done") {
          transferredFiles.push(filesToSend[index])
        }
      })
    } else if (receiveFileRefs) {
      receiveFileRefs.forEach((receiveActor) => {
        if (receiveActor.getSnapshot().status === "done") {
          const metadata = receiveActor.getSnapshot().context.metadata
          if (metadata) transferredFiles.push(metadata)
        }
      })
    }

    return {
      filesToSend,
      receiveFileRefs,
      sendFileRefs,
      request,
      transferredFiles,
    }
  })

  if (!state.filesToSend || !state.request) return null

  return (
    <div className="gap-2">
      {state.filesToSend.map((file, index) => {
        const sendActorRef = state.sendFileRefs?.[index]
        const receiveActorRef = state.receiveFileRefs?.[index]

        return (
          <FileTransferState
            key={index}
            file={file}
            sendActorRef={sendActorRef}
            receiveActorRef={receiveActorRef}
          />
        )
      })}
    </div>
  )
}
