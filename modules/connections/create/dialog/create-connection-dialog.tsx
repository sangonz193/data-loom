"use client"

import { useMachine } from "@xstate/react"
import { PlusCircleIcon } from "lucide-react"
import type { ComponentProps } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { useTRPCClient } from "@/modules/api/client"
import { useRequiredUser } from "@/modules/auth/use-user"
import { useDevice } from "@/modules/connections/use-device"
import { createClient } from "@/utils/supabase/client"

import { ConnectionErrored } from "./connection-errored"
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
          Connect Device
        </Button>
      </DialogTrigger>

      <DialogContent className="gap-6">
        <Content />
      </DialogContent>
    </Dialog>
  )
}

function Content() {
  const device = useDevice()

  if (!device) return <Spinner />

  return <MachineContent deviceId={device.id} />
}

function MachineContent({ deviceId }: { deviceId: string }) {
  const user = useRequiredUser()
  const supabase = createClient()
  const trpcClient = useTRPCClient()
  const [state, send] = useMachine(newConnectionMachine, {
    input: {
      supabase,
      currentUser: user,
      deviceId,
      trpcClient,
    },
  })

  const { createdCode } = state.context

  const isLoading =
    state.matches("creating code") ||
    state.matches("connecting caller") ||
    state.matches("creating user connection") ||
    state.matches("redeeming code") ||
    state.matches("connecting receiver")

  return (
    <>
      <DialogTitle className="mb-4">Set Up a New Connection</DialogTitle>

      {state.value === "idle" && <Idle state={state} send={send} />}
      {state.value === "connected" && <Success />}

      {isLoading && <Spinner />}

      {state.value === "listening for redemptions" &&
        state.context.isRedemptionListenerReady &&
        !!createdCode && (
          <DisplayCode
            code={createdCode.code}
            createdAt={createdCode.created_at}
          />
        )}

      {state.value === "connection errored" && (
        <ConnectionErrored isPeerError={!!state.context.connectionErrorEvent} />
      )}
    </>
  )
}
