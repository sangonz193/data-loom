"use client"

import { User } from "@supabase/supabase-js"
import { useMachine } from "@xstate/react"
import { PlusCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useUserQuery } from "@/modules/auth/use-user"
import { createClient } from "@/utils/supabase/client"

import { DisplayCode } from "./display-code"
import { Idle } from "./idle"
import { Success } from "./success"
import { newConnectionMachine } from "../new-connection"

type Props = {
  className?: string
}

export function CreateConnectionDialog({ className }: Props) {
  const user = useUserQuery().data

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className={className} size="sm">
          <PlusCircleIcon className="size-5" />
          Connect device
        </Button>
      </DialogTrigger>

      <DialogContent className="gap-8">
        {user && <Content user={user} />}
      </DialogContent>
    </Dialog>
  )
}

function Content({ user }: { user: User }) {
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
