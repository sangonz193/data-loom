import { useMachine } from "@xstate/react"
import { XIcon } from "lucide-react"
import { useEffect, useRef } from "react"
import { useDropzone } from "react-dropzone"

import { Avatar, getUserName } from "@/components/avatar"
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
import { cn } from "@/lib/cn"
import { themeClassNames } from "@/styles/themeClasses"
import { createClient } from "@/utils/supabase/client"

import { connectionMachine } from "./machine"
import { Button } from "../../../components/ui/button"
import { useRequiredUser } from "../../auth/use-user"
import { DeleteConnection } from "../delete-connection"
import { IncomingConnections } from "../incoming-connections"
import { useUserConnectionsQuery } from "../use-user-connections"
import { WebRtcSignalsOutputEvent } from "../web-rtc-signals"

type Props = {
  connection: NonNullable<
    ReturnType<typeof useUserConnectionsQuery>["data"]
  >[number]
}

export function Connection({ connection }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()
  const user = useRequiredUser()
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (files) => {
      const file = files[0]
      if (file) {
        send({ type: "send-file", file })
      }
    },
  })

  const remoteUserNumber = user.id === connection.user_1_id ? 2 : 1
  const remoteUser = connection[`user_${remoteUserNumber}`]
  const remoteUserId = connection[`user_${remoteUserNumber}_id`]

  const [state, send] = useMachine(connectionMachine, {
    input: {
      supabase,
      currentUser: user,
      remoteUserId,
    },
  })

  const incomingConnectionsRef = IncomingConnections.useActorRef()

  useEffect(() => {
    const handler = (event: WebRtcSignalsOutputEvent) => {
      if (event.type === "signals.offer")
        send({ type: "connection-request-received", offer: event.offer })
    }

    incomingConnectionsRef.send({
      type: "register-handler",
      remoteUserId,
      handler,
    })

    return () => {
      incomingConnectionsRef.send({
        type: "unregister-handler",
        remoteUserId,
        handler,
      })
    }
  }, [incomingConnectionsRef, remoteUserId, send])

  return (
    <div
      className={cn(
        "relative gap-3 rounded-md border border-primary/50 bg-card p-4",
        themeClassNames[
          (remoteUser?.color_id as keyof typeof themeClassNames) || "default"
        ],
      )}
      {...getRootProps()}
    >
      <div className="flex-row gap-3">
        <Avatar
          animalEmoji={remoteUser?.animals?.emoji}
          animalLabel={remoteUser?.animals?.label}
          colorLabel={remoteUser?.colors?.label}
        />

        <div className="grow">
          <h2 className="font-bold">
            {getUserName({
              colorLabel: remoteUser?.colors?.label,
              animalLabel: remoteUser?.animals?.label,
            })}
          </h2>

          {(state.value === "connecting" ||
            state.value === "connecting with caller") && (
            <span className="animate-pulse text-muted-foreground">
              Connecting...
            </span>
          )}

          {(state.value === "sending file" ||
            state.value === "receiving file") && (
            <span className="text-green-500/50">Connected</span>
          )}
        </div>

        <input
          {...getInputProps({
            ref: inputRef,
            className: "hidden",
          })}
        />

        {state.value === "prompting user to accept connection" && (
          <AlertDialog open>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Accept the file?</AlertDialogTitle>
                <AlertDialogDescription>
                  {getUserName({
                    colorLabel: remoteUser?.colors?.label,
                    animalLabel: remoteUser?.animals?.label,
                  })}{" "}
                  wants to send you a file. Do you want to accept it?
                </AlertDialogDescription>
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
        )}
      </div>

      {state.context.fileSharingState && (
        <div className="relative overflow-hidden rounded-md bg-accent">
          <div
            className="absolute bottom-0 left-0 top-0 bg-green-500/50 transition-[width]"
            style={{
              width: `${getProgressPercentage(state.context.fileSharingState.transferredBytes, state.context.fileSharingState.metadata.size)}%`,
            }}
          />

          <div className="relative flex-row items-center gap-2 px-3 py-1">
            <div className="min-h-10 shrink grow flex-row items-center">
              <span className="w-full break-words">
                {state.context.fileSharingState.metadata?.name}
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
        </div>
      )}

      <div className="flex-row-reverse gap-3">
        <DeleteConnection connection={connection} />

        {state.can({ type: "send-file" }) && (
          <Button variant="ghost" onClick={() => inputRef.current?.click()}>
            Send file
          </Button>
        )}
      </div>

      <div className="pointer-events-none absolute inset-0">
        <div
          className={cn(
            "absolute inset-0 bg-accent opacity-0 transition-opacity duration-300",
            isDragActive && "opacity-70",
          )}
        />

        <span
          className={cn(
            "opacity-0",
            "my-auto text-center text-lg text-accent-foreground transition-opacity",
            isDragActive && "opacity-70",
          )}
        >
          Drop the file here to send it
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
