import { useSelector } from "@xstate/react"
import { ActorRefFrom } from "xstate"
import { z } from "zod"

import { FileTransferState } from "./file-transfer-state"
import { connectionMachine } from "./machine"
import { requestPayloadSchema } from "../file-sharing-requests/payload"

type Props = {
  actor: ActorRefFrom<typeof connectionMachine>
}

export function FilesList({ actor }: Props) {
  const state = useSelector(actor, (state) => {
    const {
      context: { filesToSend, receiveFileRefs, sendFileRefs, request },
    } = state

    return {
      filesToSend,
      receiveFileRefs,
      sendFileRefs,
      request,
    }
  })

  if (!state.filesToSend && !state.request) return null

  const files =
    state.filesToSend ||
    (state.request?.payload as z.infer<typeof requestPayloadSchema>).files

  return (
    <div className="gap-2">
      {files.map((file, index) => {
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
