import { useMachine } from "@xstate/react"
import { useEffect, useRef } from "react"

import { Avatar } from "@/components/avatar"
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

import { DeleteConnection } from "./delete-connection"
import { IncomingConnections } from "./incoming-connections"
import { connectionMachine } from "./item/machine"
import { useUserConnectionsQuery } from "./use-user-connections"
import { WebRtcSignalsOutputEvent } from "./web-rtc-signals"
import { Button } from "../../components/ui/button"
import { useRequiredUser } from "../auth/use-user"

type Props = {
  connection: NonNullable<
    ReturnType<typeof useUserConnectionsQuery>["data"]
  >[number]
}

export function Connection({ connection }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()
  const user = useRequiredUser()

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
        "flex-row gap-3 rounded-md border bg-card p-4",
        themeClassNames[
          (remoteUser?.color_id as keyof typeof themeClassNames) || "default"
        ],
      )}
    >
      <Avatar
        animalEmoji={remoteUser?.animals?.emoji}
        animalLabel={remoteUser?.animals?.label}
        colorLabel={remoteUser?.colors?.label}
      />

      <div className="grow" />

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) {
            send({ type: "send-file", file })
          }
        }}
      />
      {state.can({ type: "send-file" }) && (
        <Button variant="ghost" onClick={() => inputRef.current?.click()}>
          Send file
        </Button>
      )}

      <DeleteConnection connection={connection} />

      {state.value === "prompting user to accept connection" && (
        <AlertDialog open>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This will delete the connection. To communicate with this device
                again, you will need to create a new connection.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => send({ type: "decline" })}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => send({ type: "accept" })}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
