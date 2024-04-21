"use client"

import { useMachine } from "@xstate/react"
import { PlusCircleIcon } from "lucide-react"
import { useEffect } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { logger } from "@/logger"
import { useRequiredUser } from "@/modules/auth/use-user"
import { createClient } from "@/utils/supabase/client"

import { DisplayCode } from "./display-code"
import { Idle } from "./idle"
import { Success } from "./success"
import { IncomingConnections } from "../../incoming-connections"
import { newConnectionMachine } from "../new-connection"

type Props = {
  className?: string
}

export function CreateConnectionDialog({ className }: Props) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className={className} size="sm">
          <PlusCircleIcon className="size-5" />
          Connect device
        </Button>
      </DialogTrigger>

      <DialogContent className="gap-8">
        <Content />
      </DialogContent>
    </Dialog>
  )
}

function Content() {
  const incomingConnectionsRef = IncomingConnections.useActorRef()
  useEffect(() => {
    logger.info("Sending pause to incoming connections actor")
    incomingConnectionsRef.send({ type: "pause" })

    return () => {
      logger.info("Sending resume to incoming connections actor")
      incomingConnectionsRef.send({ type: "resume" })
    }
  }, [incomingConnectionsRef])

  const user = useRequiredUser()
  const supabase = createClient()
  const [state, send] = useMachine(newConnectionMachine, {
    input: {
      supabase,
      currentUser: user,
    },
  })

  const code = state.context.code

  const loadingStates: (typeof state.value)[] = [
    "creating code",
    "connecting caller",
    "creating user connection",

    "redeeming code",
    "connecting receiver",
  ]

  return (
    <>
      <DialogTitle className="mb-4">Set Up a New Connection</DialogTitle>

      {state.value === "idle" && <Idle state={state} send={send} />}
      {state.value === "connected" && <Success />}

      {loadingStates.includes(state.value) && <Spinner />}

      {state.value === "listening for redemptions" && !!code && (
        <DisplayCode code={code} />
      )}
    </>
  )
}
