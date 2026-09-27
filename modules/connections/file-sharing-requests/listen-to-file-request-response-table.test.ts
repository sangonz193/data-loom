import { expect, test } from "bun:test"
import { createActor, setup } from "xstate"

import type { Tables } from "@/supabase/types"

import {
  listenToFileRequestResponseTable,
  type ListenToFileRequestResponseTableOutputEvent,
} from "./listen-to-file-request-response-table"

const response = {
  request_id: "request-a",
  accepted: true,
  accepted_by_device_id: "device-b",
  created_at: new Date().toISOString(),
} satisfies Tables<"share_request_responses">

function startListener() {
  const events: ListenToFileRequestResponseTableOutputEvent[] = []
  const snapshot = Promise.withResolvers<{
    data: typeof response | null
    error: Error | null
  }>()
  let onInsert: (payload: { new: typeof response }) => void = () => {}
  let onStatus: (status: string, error?: Error) => void = () => {}
  let reads = 0
  let removed = false
  let signal: AbortSignal | undefined
  const channel = {
    on: (event: string, filter: unknown, callback: typeof onInsert) => {
      expect(event).toBe("postgres_changes")
      expect(filter).toEqual({
        event: "INSERT",
        schema: "public",
        table: "share_request_responses",
        filter: "request_id=eq.request-a",
      })
      onInsert = callback
      return channel
    },
    subscribe: (callback: typeof onStatus) => {
      onStatus = callback
      return channel
    },
  }
  const query = {
    select: () => query,
    eq: (column: string, value: string) => {
      expect([column, value]).toEqual(["request_id", "request-a"])
      return query
    },
    abortSignal: (value: AbortSignal) => {
      signal = value
      return query
    },
    maybeSingle: () => {
      reads++
      return snapshot.promise
    },
  }
  const supabase = {
    channel: (name: string, options: unknown) => {
      expect(name).toBe("file_requests_response:request-a")
      expect(options).toEqual({
        config: { postgres_changes_options: { wait: true } },
      })
      return channel
    },
    from: (table: string) => {
      expect(table).toBe("share_request_responses")
      return query
    },
    removeChannel: (value: unknown) => {
      expect(value).toBe(channel)
      removed = true
    },
  }
  const actor = createActor(
    setup({
      types: { events: {} as ListenToFileRequestResponseTableOutputEvent },
      actors: { listenToFileRequestResponseTable },
    }).createMachine({
      invoke: {
        src: "listenToFileRequestResponseTable",
        input: { supabase: supabase as never, requestId: "request-a" },
      },
      on: {
        "*": {
          actions: ({ event }) => {
            events.push(event)
          },
        },
      },
    }),
  ).start()
  return {
    actor,
    events,
    snapshot,
    insert: () => onInsert({ new: response }),
    status: (status: string, error?: Error) => onStatus(status, error),
    get reads() {
      return reads
    },
    get removed() {
      return removed
    },
    get signal() {
      return signal
    },
  }
}

async function settle() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

for (const liveFirst of [true, false]) {
  test(`snapshot and live response deliver once with ${liveFirst ? "live" : "snapshot"} first`, async () => {
    const listener = startListener()
    expect(listener.reads).toBe(0)
    listener.status("SUBSCRIBED")
    expect(listener.reads).toBe(1)
    if (liveFirst) listener.insert()
    listener.snapshot.resolve({ data: response, error: null })
    await settle()
    listener.insert()
    expect(listener.events).toEqual([
      { type: "file-request-response", response },
    ])
    listener.actor.stop()
    expect(listener.removed).toBe(true)
    expect(listener.signal?.aborted).toBe(true)
  })
}

test("an empty snapshot keeps listening for a later response", async () => {
  const listener = startListener()
  listener.status("SUBSCRIBED")
  listener.snapshot.resolve({ data: null, error: null })
  await settle()
  expect(listener.events).toEqual([])
  listener.insert()
  expect(listener.events).toEqual([{ type: "file-request-response", response }])
  listener.actor.stop()
})

for (const error of [false, true]) {
  test(`stopping the listener ignores pending snapshot ${error ? "errors" : "responses"} and live events`, async () => {
    const listener = startListener()
    listener.status("SUBSCRIBED")
    listener.actor.stop()
    expect(listener.signal?.aborted).toBe(true)
    listener.snapshot.resolve({
      data: response,
      error: error ? new Error("Aborted") : null,
    })
    listener.insert()
    listener.status("CHANNEL_ERROR")
    await settle()
    expect(listener.events).toEqual([])
    expect(listener.removed).toBe(true)
  })
}

for (const status of ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) {
  test(`${status} reports a recoverable listener failure once`, () => {
    const listener = startListener()
    listener.status(status)
    listener.status(status)
    listener.insert()
    expect(listener.events).toEqual([{ type: "file-request-response.failed" }])
    expect(listener.reads).toBe(0)
    listener.actor.stop()
  })
}

for (const rejects of [true, false]) {
  test(`snapshot ${rejects ? "rejection" : "error"} reports a recoverable failure`, async () => {
    const listener = startListener()
    listener.status("SUBSCRIBED")
    const error = new Error("Read failed")
    if (rejects) listener.snapshot.reject(error)
    else listener.snapshot.resolve({ data: null, error })
    await settle()
    expect(listener.events).toEqual([{ type: "file-request-response.failed" }])
    listener.actor.stop()
  })
}

test("a snapshot failure after a live response does not undo delivery", async () => {
  const listener = startListener()
  listener.status("SUBSCRIBED")
  listener.insert()
  listener.snapshot.reject(new Error("Read failed"))
  await settle()
  expect(listener.events).toEqual([{ type: "file-request-response", response }])
  listener.actor.stop()
})
