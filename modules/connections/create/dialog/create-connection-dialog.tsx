"use client"

import { useMachine } from "@xstate/react"
import { PlusCircleIcon } from "lucide-react"
import { ComponentProps } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useRequiredUser } from "@/modules/auth/use-user"
import { createClient } from "@/utils/supabase/client"

import { DisplayCode } from "./display-code"
import { Idle } from "./idle"
import { Success } from "./success"
import { newConnectionMachine } from "../new-connection"

type Props = {
  className?: string
  size?: ComponentProps<typeof Button>["size"]
}

export function CreateConnectionDialog({ className, size = "sm" }: Props) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className={className} size={size}>
          <PlusCircleIcon className="size-5" />
          Connect device
        </Button>
      </DialogTrigger>

      <DialogContent className="gap-6">
        <Content />
      </DialogContent>
    </Dialog>
  )
}

function Content() {
  const user = useRequiredUser()
  const supabase = createClient()
  const [state, send] = useMachine(newConnectionMachine, {
    input: {
      supabase,
      currentUser: user,
    },
  })

  const { createdCode } = state.context

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

      {state.value === "listening for redemptions" && !!createdCode && (
        <DisplayCode
          code={createdCode.code}
          createdAt={createdCode.created_at}
        />
      )}
    </>
  )
}
