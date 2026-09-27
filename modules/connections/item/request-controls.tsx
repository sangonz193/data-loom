import type { ActorRefFrom, SnapshotFrom } from "xstate"

import { Button } from "@/components/ui/button"

import type { connectionMachine } from "./machine"

export function RequestControls({
  state,
  send,
}: {
  state: SnapshotFrom<typeof connectionMachine>
  send: ActorRefFrom<typeof connectionMachine>["send"]
}) {
  const failed =
    state.matches("request failed") ||
    state.matches("cancellation failed") ||
    state.matches("decline failed") ||
    state.matches({ "receiving connection": "acceptance failed" })

  return (
    <>
      {state.can({ type: "retry-watcher" }) && (
        <div role="alert" className="flex-row items-center gap-2 text-sm">
          <span>Could not check the file request.</span>
          <Button
            variant="outline"
            onClick={() => send({ type: "retry-watcher" })}
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            onClick={() => send({ type: "dismiss-watcher" })}
          >
            Dismiss
          </Button>
        </div>
      )}
      {state.matches("cancelling request") && (
        <div role="status" className="flex-row items-center gap-2 text-sm">
          <span>Cancelling request...</span>
          <Button
            variant="ghost"
            onClick={() => send({ type: "dismiss-error" })}
          >
            Dismiss
          </Button>
        </div>
      )}
      {failed && (
        <div role="alert" className="flex-row items-center gap-2 text-sm">
          <span>
            {state.matches("cancellation failed") ?
              "Could not confirm cancellation. This device has stopped sending."
            : state.matches("request failed") ?
              "Could not complete the file request."
            : state.matches({ "receiving connection": "acceptance failed" }) ?
              "Could not accept the file request."
            : "Could not decline the file request."}
          </span>
          <Button variant="outline" onClick={() => send({ type: "retry" })}>
            Retry
          </Button>
          <Button
            variant="ghost"
            onClick={() => send({ type: "dismiss-error" })}
          >
            Dismiss
          </Button>
        </div>
      )}
      {state.can({ type: "cancel" }) && (
        <Button variant="outline" onClick={() => send({ type: "cancel" })}>
          Cancel
        </Button>
      )}
    </>
  )
}
