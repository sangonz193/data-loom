import { filesize } from "filesize"
import { useMemo } from "react"
import { Actor, StateFrom } from "xstate"
import { z } from "zod"

import { getUserName } from "@/components/avatar"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

import { connectionMachine } from "./machine"
import { requestPayloadSchema } from "../file-sharing-requests/payload"
import { useUserConnectionsQuery } from "../use-user-connections"

type Props = {
  send: Actor<typeof connectionMachine>["send"]
  state: StateFrom<typeof connectionMachine>
  remoteUser: NonNullable<
    ReturnType<typeof useUserConnectionsQuery>["data"]
  >[number]["user_1"]
}

export function FileTransferRequestDialog({ send, state, remoteUser }: Props) {
  const { request } = state.context
  const metadata = (request?.payload as z.infer<typeof requestPayloadSchema>)
    .files

  const description = useMemo(() => {
    let description = `${getUserName({
      colorLabel: remoteUser?.colors?.label,
      animalLabel: remoteUser?.animals?.label,
    })} is sending you`

    const totalSize = metadata.reduce((acc, file) => acc + file.size, 0)

    if (metadata.length !== 1) {
      description += ` ${metadata.length} files`
    } else {
      description += ` "${metadata[0].name}"`
    }

    description += ` (${filesize(totalSize)}). Do you want to accept it?`

    return description
  }, [metadata, remoteUser?.animals?.label, remoteUser?.colors?.label])

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            File Transfer request from{" "}
            {getUserName({
              colorLabel: remoteUser?.colors?.label,
              animalLabel: remoteUser?.animals?.label,
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => send({ type: "decline" })}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => send({ type: "accept" })}>
            Accept
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
