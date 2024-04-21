import { useState } from "react"
import { Actor, StateFrom } from "xstate"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"

import { newConnectionMachine } from "../new-connection"

type Props = {
  state: StateFrom<typeof newConnectionMachine>
  send: Actor<typeof newConnectionMachine>["send"]
}

export function Idle({ state, send }: Props) {
  const [code, setCode] = useState("")

  return (
    <>
      {state.value === "idle" && (
        <Button
          variant="outline"
          className="h-auto justify-start"
          onClick={() => send({ type: "create-code" })}
        >
          <div className="min-w-0 shrink items-start py-2">
            <span className="whitespace-pre-wrap text-start text-base font-medium">
              Generate Connection Code
            </span>

            <span className="whitespace-pre-wrap text-start text-sm text-muted-foreground">
              Start connecting a new device by generating a unique code.
            </span>
          </div>
        </Button>
      )}

      <Separator />

      <div>
        <span className="font-medium">Enter Connection Code</span>

        <span className="text-sm text-muted-foreground">
          Already have a code from another device? Enter it here.
        </span>

        <div className="mt-3 flex-row">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="shrink rounded-r-none"
          />

          <Button
            variant="secondary"
            className="rounded-l-none"
            onClick={() => code && send({ type: "redeem-code", code: code })}
          >
            Join
          </Button>
        </div>
      </div>
    </>
  )
}
