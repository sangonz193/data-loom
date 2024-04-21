import { User } from "@supabase/supabase-js"
import { createActorContext } from "@xstate/react"
import { PropsWithChildren } from "react"
import { assign, setup } from "xstate"

import { useRequiredUser } from "@/modules/auth/use-user"
import { createClient } from "@/utils/supabase/client"

import {
  ListenToFileRequestTableOutputEvent,
  listenToFileRequestTable,
} from "./listen-to-file-request-table"

type Input = {
  supabase: ReturnType<typeof createClient>
  currentUser: User
}

interface Context extends Input {
  handlers: Record<
    string,
    ((event: ListenToFileRequestTableOutputEvent) => void)[] | undefined
  >
}

type InputEvent =
  | {
      type: "register-handler"
      remoteUserId: string
      handler: (event: ListenToFileRequestTableOutputEvent) => void
    }
  | {
      type: "unregister-handler"
      remoteUserId: string
      handler: (event: ListenToFileRequestTableOutputEvent) => void
    }

type Event = ListenToFileRequestTableOutputEvent | InputEvent

const incomingFileSharingRequestsMachine = setup({
  types: {
    context: {} as Context,
    input: {} as Input,
    events: {} as Event,
    children: {} as {
      listenToFileRequestTable: "listenToFileRequestTable"
    },
  },
  actions: {
    registerHandler: assign({
      handlers: (
        { context },
        event: Extract<InputEvent, { type: "register-handler" }>,
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
        event: Extract<InputEvent, { type: "unregister-handler" }>,
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
    notifyHandlers: (
      { context },
      event: ListenToFileRequestTableOutputEvent,
    ) => {
      const handlers = context.handlers[event.fileRequest.from_user_id] ?? []
      handlers.forEach((handler) => handler(event))
    },
  },
  actors: {
    listenToFileRequestTable: listenToFileRequestTable,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QEsB2BjA9gWzVAtAGbIA2Y+sAFgIYBOe+tYAjgK5wAusAxE1MrA5ha+GqghlaAbQAMAXUSgADpljIOyTKkUgAHogCMAJgBsAOgAcJgMxGAnCYCsMiwHYLdmSYA0IAJ6IRjIALGaeJkaOAL5RvmhYuKgExGQUNPRJjCzsgjysqHwCQiJiEsKyCkggKmoaWjr6CAYGrmau1iEWwTIu7uG+AU0uZsGO1sbRsSDxOAwp5FR0DExsnDzzWauCZgBUFTo16praVY0G1qGuBsEWjp69Hl4DhkYxU6iYEHA6M4nJpAt0stsmsDqojvVToZXM8EPZzLc7NZXJM4hhZpkNosMgQVjkuGYSEUwKg8GDascGognLDRjIzNY7sjJjEgA */
  id: "incoming-file-sharing-requests",

  context: ({ input }) => ({ ...input, handlers: {} }),

  invoke: {
    src: "listenToFileRequestTable",
    id: "listenToFileRequestTable",
    input: ({ context }) => ({
      ...context,
    }),
  },

  initial: "listening",

  states: {
    listening: {},
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
    "file-request.*": {
      actions: {
        type: "notifyHandlers",
        params: ({ event }) => event,
      },
    },
  },
})

export const IncomingFileSharingRequests = createActorContext(
  incomingFileSharingRequestsMachine,
)

export function IncomingFileSharingRequestsProvider({
  children,
}: PropsWithChildren) {
  const user = useRequiredUser()

  return (
    <IncomingFileSharingRequests.Provider
      options={{
        input: {
          supabase: createClient(),
          currentUser: user,
        },
      }}
    >
      {children}
    </IncomingFileSharingRequests.Provider>
  )
}
