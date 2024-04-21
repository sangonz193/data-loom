"use client"

import { User } from "@supabase/supabase-js"
import { createActorContext } from "@xstate/react"
import { PropsWithChildren } from "react"
import { assign, setup } from "xstate"

import { createClient } from "@/utils/supabase/client"

import { WebRtcSignalsOutputEvent, webRtcSignals } from "./web-rtc-signals"
import { useRequiredUser } from "../auth/use-user"

type Input = {
  currentUser: User
  supabase: ReturnType<typeof createClient>
}

interface Context extends Input {
  handlers: Record<
    string,
    ((event: WebRtcSignalsOutputEvent) => void)[] | undefined
  >
}

type IncomingConnectionsInputEvent =
  | {
      type: "pause"
    }
  | {
      type: "resume"
    }
  | {
      type: "register-handler"
      remoteUserId: string
      handler: (event: WebRtcSignalsOutputEvent) => void
    }
  | {
      type: "unregister-handler"
      remoteUserId: string
      handler: (event: WebRtcSignalsOutputEvent) => void
    }

type Event = IncomingConnectionsInputEvent | WebRtcSignalsOutputEvent

const incomingConnectionsMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as Input,
    children: {} as {
      webRtcSignals: "webRtcSignals"
    },
  },
  actions: {
    registerHandler: assign({
      handlers: (
        { context },
        event: Extract<
          IncomingConnectionsInputEvent,
          { type: "register-handler" }
        >,
      ) => ({
        ...context.handlers,
        [event.remoteUserId]: [
          ...(context.handlers[event.remoteUserId] ?? []),
          event.handler,
        ],
      }),
    }),
    unregisterHandler: assign({
      handlers: (
        { context },
        event: Extract<
          IncomingConnectionsInputEvent,
          { type: "unregister-handler" }
        >,
      ) => {
        const remoteUserHandlers = context.handlers[event.remoteUserId]?.filter(
          (handler) => handler !== event.handler,
        )

        return {
          ...context.handlers,
          [event.remoteUserId]: remoteUserHandlers?.length
            ? remoteUserHandlers
            : undefined,
        }
      },
    }),
    notifyHandlers: ({ context }, event: WebRtcSignalsOutputEvent) => {
      const handlers = context.handlers[event.remoteUserId] ?? []
      handlers.forEach((handler) => handler(event))
    },
  },
  actors: {
    webRtcSignals,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QEsB2BjA9gWzVAtFqqmOgC7KaqwDEATmFMrGWHfgBYCGqEANmwDaABgC6iUAAdMsZBSoSQAD0QBGABwAWAHQB2AJwAmfQDZ1ugKwAaEAE9Eh4Tv3CTh9cIurLu9asMAvgE2aFi4qAREJOSU1DQArqgMTCxsnDz8QmKK0rLyqIoqCN4W2iYmwqoWbtZ2asLq2poWAMz+FkEhGDh4hFTR+bSyUKhcfLDaAFQi4kgguXKxhWpGZZrNJt4mPn6GNvbFgcEgoT0RfcSkg9p8zKyoeDSSXPGwYDM5MosKc0WGui1tPpWu19ohNIYTNoWhZ9JoWhUYVUap0Tt1wpF+ldYhNnq9IPQ4PFsO9snMFvllgh-oDgW1DLUDi1LNp1LD4YivNUGUFjqhMBA4IpThiLgMcZ88ktfoh8KowdT1I0YXCEcIkdyOscRb0otiqBNbqkHhFJd8CjKEJpdAqWuYmhDdCZ9AitOpgSZUTrznqYgbtHi3hAzZTLS19KptKoTJpXAyFRDI-9NsJ-pV1IZjJpeQEgA */
  id: "incoming-connections",

  initial: "listening",

  context: ({ input }) => ({ ...input, handlers: {} }),

  states: {
    listening: {
      on: {
        pause: "paused",
      },

      invoke: {
        src: "webRtcSignals",
        id: "webRtcSignals",
        input: ({ context }) => ({
          ...context,
          remoteUserId: undefined,
        }),
      },
    },

    paused: {
      on: {
        resume: "listening",
      },
    },
  },

  on: {
    "register-handler": {
      actions: {
        type: "registerHandler",
        params: ({ event }) => event,
      },
    },
    "unregister-handler": {
      actions: {
        type: "unregisterHandler",
        params: ({ event }) => event,
      },
    },
    "signals.*": {
      actions: {
        type: "notifyHandlers",
        params: ({ event }) => event,
      },
    },
  },
})

export const IncomingConnections = createActorContext(
  incomingConnectionsMachine,
)

export function IncomingConnectionsProvider({ children }: PropsWithChildren) {
  const user = useRequiredUser()

  return (
    <IncomingConnections.Provider
      options={{
        input: {
          supabase: createClient(),
          currentUser: user,
        },
      }}
    >
      {children}
    </IncomingConnections.Provider>
  )
}
