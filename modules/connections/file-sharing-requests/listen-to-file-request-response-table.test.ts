import { expect, test, jest } from "bun:test"
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
  let snapshot = Promise.withResolvers<{
    data: typeof response | null
    error: Error | null
  }>()
  let onInsert: (payload: { new: typeof response }) => void = () => {}
  let onUpdate: (payload: {
    new: { cancelled_at: string | null }
  }) => void = () => {}
  let requestSnapshot = Promise.withResolvers<{
    data: { cancelled_at: string | null; expires_at: string } | null
    error: Error | null
  }>()
  let onStatus: (status: string, error?: Error) => void = () => {}
  let reads = 0
  let removed = false
  let signal: AbortSignal | undefined
  let topic = ""
  const channel = {
    on: (
      event: string,
      filter: { table: string; event: string; schema: string; filter: string },
      callback: typeof onInsert,
    ) => {
      expect(event).toBe("postgres_changes")
      if (filter.table === "share_requests") {
        expect(filter).toEqual({
          event: "UPDATE",
          schema: "public",
          table: "share_requests",
          filter: "id=eq.request-a",
        })
        onUpdate = callback as unknown as typeof onUpdate
        return channel
      }
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
      topic = name
      expect(name).toStartWith("file_request:request-a:")
      expect(options).toEqual({
        config: { postgres_changes_options: { wait: true } },
      })
      return channel
    },
    from: (table: string) => {
      if (table === "share_requests")
        return {
          ...query,
          select() {
            return this
          },
          eq(column: string, value: string) {
            expect([column, value]).toEqual(["id", "request-a"])
            return this
          },
          abortSignal(value: AbortSignal) {
            signal = value
            return this
          },
          maybeSingle() {
            reads++
            return requestSnapshot.promise
          },
        }
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
    get snapshot() {
      return snapshot
    },
    get requestSnapshot() {
      return requestSnapshot
    },
    nextSnapshot: () => {
      snapshot = Promise.withResolvers()
      requestSnapshot = Promise.withResolvers()
    },
    topic,
    open: (expiresAt = new Date(Date.now() + 600_000).toISOString()) =>
      requestSnapshot.resolve({
        data: { cancelled_at: null, expires_at: expiresAt },
        error: null,
      }),
    cancel: () => onUpdate({ new: { cancelled_at: new Date().toISOString() } }),
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
    expect(listener.reads).toBe(2)
    listener.open()
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
  listener.open()
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
    listener.open()
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
    listener.open()
    const error = new Error("Read failed")
    if (rejects) listener.snapshot.reject(error)
    else listener.snapshot.resolve({ data: null, error })
    await settle()
    expect(listener.events).toEqual([{ type: "file-request-response.failed" }])
    listener.actor.stop()
  })
}

test("a snapshot failure does not deliver a buffered acceptance without checking cancellation", async () => {
  const listener = startListener()
  listener.status("SUBSCRIBED")
  listener.open()
  listener.insert()
  listener.snapshot.reject(new Error("Read failed"))
  await settle()
  expect(listener.events).toEqual([{ type: "file-request-response.failed" }])
  listener.actor.stop()
})

for (const source of ["snapshot", "live"] as const) {
  test(`cancellation from ${source} wins over a buffered acceptance`, async () => {
    const listener = startListener()
    listener.status("SUBSCRIBED")
    listener.insert()
    if (source === "live") {
      listener.cancel()
      listener.open()
    } else {
      listener.requestSnapshot.resolve({
        data: {
          cancelled_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
        error: null,
      })
    }
    listener.snapshot.resolve({ data: response, error: null })
    await settle()
    listener.cancel()
    listener.insert()
    expect(listener.events).toEqual([
      { type: "file-request.cancelled", requestId: response.request_id },
    ])
    listener.actor.stop()
  })
}

test("delivering a response keeps listening for explicit cancellation", async () => {
  const listener = startListener()
  listener.status("SUBSCRIBED")
  listener.open()
  listener.snapshot.resolve({ data: response, error: null })
  await settle()
  listener.cancel()
  expect(listener.events.map(({ type }) => type)).toEqual([
    "file-request-response",
    "file-request.cancelled",
  ])
  listener.actor.stop()
})

test("each watcher uses a distinct topic for the same request", () => {
  const first = startListener()
  const second = startListener()
  expect(first.topic).not.toBe(second.topic)
  first.actor.stop()
  second.actor.stop()
})

for (const accepted of [false, true]) {
  test(`expiry timer ${accepted ? "preserves accepted transfers" : "expires unanswered prompts"} and is removed on cleanup`, async () => {
    jest.useFakeTimers()
    const listener = startListener()
    try {
      listener.status("SUBSCRIBED")
      listener.open(new Date(Date.now() + 1_000).toISOString())
      listener.snapshot.resolve({ data: null, error: null })
      await settle()
      jest.advanceTimersByTime(999)
      expect(listener.events).toEqual([])
      if (accepted) listener.insert()
      jest.advanceTimersByTime(1)
      await settle()
      expect(listener.events.map(({ type }) => type)).toEqual([
        accepted ? "file-request-response" : "file-request.expired",
      ])
      listener.actor.stop()
      expect(jest.getTimerCount()).toBe(0)
      listener.cancel()
      listener.insert()
      jest.advanceTimersByTime(600_000)
      expect(listener.events).toHaveLength(1)
    } finally {
      listener.actor.stop()
      jest.useRealTimers()
    }
  })
}

for (const outcome of ["accepted", "expired", "cancelled"] as const) {
  test(`expiry reconciles a delayed persisted ${outcome} snapshot before emitting once`, async () => {
    jest.useFakeTimers()
    const listener = startListener()
    try {
      const expiresAt = new Date(Date.now() + 1_000).toISOString()
      listener.status("SUBSCRIBED")
      listener.open(expiresAt)
      listener.snapshot.resolve({ data: null, error: null })
      await settle()
      listener.nextSnapshot()
      jest.advanceTimersByTime(999)
      const persistedResponse = outcome === "expired" ? null : response
      const cancelledAt =
        outcome === "cancelled" ? new Date().toISOString() : null
      jest.advanceTimersByTime(1)
      expect(listener.reads).toBe(4)
      expect(listener.events).toEqual([])
      listener.requestSnapshot.resolve({
        data: { cancelled_at: cancelledAt, expires_at: expiresAt },
        error: null,
      })
      await settle()
      jest.advanceTimersByTime(500)
      expect(listener.events).toEqual([])
      listener.snapshot.resolve({ data: persistedResponse, error: null })
      await settle()
      expect(listener.events).toEqual([
        outcome === "accepted" ?
          { type: "file-request-response", response }
        : { type: `file-request.${outcome}`, requestId: response.request_id },
      ])
      listener.insert()
      listener.status("SUBSCRIBED")
      await settle()
      jest.advanceTimersByTime(60_000)
      expect(listener.events).toHaveLength(1)
      expect(jest.getTimerCount()).toBe(0)
      listener.actor.stop()
      expect(listener.removed).toBe(true)
      expect(listener.signal?.aborted).toBe(true)
    } finally {
      listener.actor.stop()
      jest.useRealTimers()
    }
  })
}

test("an unanswered snapshot started before expiry is reconciled again after the deadline", async () => {
  jest.useFakeTimers()
  const listener = startListener()
  try {
    const expiresAt = new Date(Date.now() + 1_000).toISOString()
    listener.status("SUBSCRIBED")
    listener.open(expiresAt)
    const staleSnapshot = listener.snapshot
    listener.nextSnapshot()
    jest.advanceTimersByTime(1_000)
    staleSnapshot.resolve({ data: null, error: null })
    await settle()
    expect(listener.events).toEqual([])
    jest.advanceTimersByTime(1)
    expect(listener.reads).toBe(4)
    listener.open(expiresAt)
    listener.snapshot.resolve({ data: response, error: null })
    await settle()
    expect(listener.events).toEqual([
      { type: "file-request-response", response },
    ])
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    listener.actor.stop()
    jest.useRealTimers()
  }
})

for (const failure of [
  "request",
  "response",
  "rejection",
  "timeout",
] as const) {
  test(`expiry snapshot ${failure} failure never expires or delivers a late acceptance`, async () => {
    jest.useFakeTimers()
    const listener = startListener()
    try {
      const expiresAt = new Date(Date.now() + 1_000).toISOString()
      listener.status("SUBSCRIBED")
      listener.open(expiresAt)
      listener.snapshot.resolve({ data: null, error: null })
      await settle()
      listener.nextSnapshot()
      jest.advanceTimersByTime(1_000)
      const error = new Error("Read failed")
      if (failure === "timeout") {
        jest.advanceTimersByTime(15_000)
        expect(listener.signal?.aborted).toBe(true)
      } else if (failure === "rejection") {
        listener.snapshot.reject(error)
      } else {
        listener.requestSnapshot.resolve({
          data: { cancelled_at: null, expires_at: expiresAt },
          error: failure === "request" ? error : null,
        })
        listener.snapshot.resolve({
          data: null,
          error: failure === "response" ? error : null,
        })
      }
      await settle()
      expect(listener.events).toEqual([
        { type: "file-request-response.failed" },
      ])
      listener.insert()
      listener.open(expiresAt)
      listener.snapshot.resolve({ data: response, error: null })
      await settle()
      jest.advanceTimersByTime(60_000)
      expect(listener.events).toEqual([
        { type: "file-request-response.failed" },
      ])
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      listener.actor.stop()
      jest.useRealTimers()
    }
  })
}

for (const cleanup of ["stop", "cancel"] as const) {
  test(`${cleanup} suppresses delayed expiry reconciliation and live responses`, async () => {
    jest.useFakeTimers()
    const listener = startListener()
    try {
      const expiresAt = new Date(Date.now() + 1_000).toISOString()
      listener.status("SUBSCRIBED")
      listener.open(expiresAt)
      listener.snapshot.resolve({ data: null, error: null })
      await settle()
      listener.nextSnapshot()
      jest.advanceTimersByTime(1_000)
      expect(listener.reads).toBe(4)
      if (cleanup === "stop") {
        listener.actor.stop()
        expect(listener.signal?.aborted).toBe(true)
        expect(listener.removed).toBe(true)
      } else listener.cancel()
      listener.open(expiresAt)
      listener.snapshot.resolve({ data: response, error: null })
      listener.insert()
      await settle()
      jest.advanceTimersByTime(60_000)
      expect(listener.events).toEqual(
        cleanup === "stop" ?
          []
        : [{ type: "file-request.cancelled", requestId: response.request_id }],
      )
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      listener.actor.stop()
      jest.useRealTimers()
    }
  })
}

for (const subscribed of [false, true]) {
  test(`${subscribed ? "snapshot read" : "subscription"} timeout is bounded and cleanup cancels pending work`, () => {
    jest.useFakeTimers()
    const listener = startListener()
    try {
      if (subscribed) listener.status("SUBSCRIBED")
      jest.advanceTimersByTime(14_999)
      expect(listener.events).toEqual([])
      jest.advanceTimersByTime(1)
      expect(listener.events).toEqual([
        { type: "file-request-response.failed" },
      ])
      if (subscribed) expect(listener.signal?.aborted).toBe(true)
      listener.actor.stop()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      listener.actor.stop()
      jest.useRealTimers()
    }
  })
}

for (const staleOutcome of ["accepted", "expired"] as const) {
  test(`reconnect during a pending ${staleOutcome} snapshot reconciles missed cancellation first`, async () => {
    jest.useFakeTimers()
    const listener = startListener()
    try {
      const expiresAt = new Date(Date.now() - 1_000).toISOString()
      listener.status("SUBSCRIBED")
      const staleRequest = listener.requestSnapshot
      const staleResponse = listener.snapshot
      listener.status("CHANNEL_ERROR")
      listener.nextSnapshot()
      listener.requestSnapshot.resolve({
        data: { cancelled_at: new Date().toISOString(), expires_at: expiresAt },
        error: null,
      })
      listener.snapshot.resolve({ data: response, error: null })
      listener.status("SUBSCRIBED")
      listener.status("SUBSCRIBED")
      expect(listener.reads).toBe(2)
      staleRequest.resolve({
        data: { cancelled_at: null, expires_at: expiresAt },
        error: null,
      })
      staleResponse.resolve({
        data: staleOutcome === "accepted" ? response : null,
        error: null,
      })
      await settle()
      expect(listener.reads).toBe(4)
      expect(listener.events).toEqual([
        { type: "file-request-response.failed" },
        { type: "file-request.cancelled", requestId: response.request_id },
      ])
      listener.status("SUBSCRIBED")
      listener.insert()
      listener.cancel()
      jest.advanceTimersByTime(60_000)
      expect(listener.reads).toBe(4)
      expect(listener.events).toHaveLength(2)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      listener.actor.stop()
      jest.useRealTimers()
    }
  })
}

test("repeated reconnects queue one fresh snapshot per pending read without replaying acceptance", async () => {
  const listener = startListener()
  try {
    listener.status("SUBSCRIBED")
    listener.open()
    listener.snapshot.resolve({ data: response, error: null })
    await settle()
    for (let index = 0; index < 2; index++) {
      listener.nextSnapshot()
      listener.status("SUBSCRIBED")
      const staleRequest = listener.requestSnapshot
      const staleResponse = listener.snapshot
      listener.nextSnapshot()
      listener.status("SUBSCRIBED")
      listener.status("SUBSCRIBED")
      staleRequest.resolve({
        data: {
          cancelled_at: null,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
        error: null,
      })
      staleResponse.resolve({ data: response, error: null })
      await settle()
      expect(listener.reads).toBe(6 + index * 4)
      listener.open()
      listener.snapshot.resolve({ data: response, error: null })
      await settle()
      expect(listener.events).toEqual([
        { type: "file-request-response", response },
      ])
    }
  } finally {
    listener.actor.stop()
  }
})

for (const cleanup of ["stop", "cancel"] as const) {
  test(`${cleanup} prevents a queued reconnect read after the pending snapshot settles`, async () => {
    jest.useFakeTimers()
    const listener = startListener()
    try {
      listener.status("SUBSCRIBED")
      listener.status("SUBSCRIBED")
      if (cleanup === "stop") {
        listener.actor.stop()
        expect(listener.signal?.aborted).toBe(true)
        expect(listener.removed).toBe(true)
      } else listener.cancel()
      listener.open()
      listener.snapshot.resolve({ data: response, error: null })
      await settle()
      listener.status("SUBSCRIBED")
      listener.insert()
      jest.advanceTimersByTime(60_000)
      expect(listener.reads).toBe(2)
      expect(listener.events).toEqual(
        cleanup === "stop" ?
          []
        : [{ type: "file-request.cancelled", requestId: response.request_id }],
      )
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      listener.actor.stop()
      jest.useRealTimers()
    }
  })
}

test("a queued reconnect snapshot retains its read timeout and cleanup", async () => {
  jest.useFakeTimers()
  const listener = startListener()
  try {
    listener.status("SUBSCRIBED")
    listener.status("SUBSCRIBED")
    listener.open()
    listener.snapshot.resolve({ data: response, error: null })
    listener.nextSnapshot()
    await settle()
    expect(listener.reads).toBe(4)
    expect(listener.events).toEqual([])
    jest.advanceTimersByTime(15_000)
    expect(listener.signal?.aborted).toBe(true)
    expect(listener.events).toEqual([{ type: "file-request-response.failed" }])
    listener.open()
    listener.snapshot.resolve({ data: response, error: null })
    await settle()
    expect(listener.events).toHaveLength(1)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    listener.actor.stop()
    jest.useRealTimers()
  }
})

test("reconnect reads both snapshots again without replaying the response", async () => {
  const listener = startListener()
  listener.status("SUBSCRIBED")
  listener.open()
  listener.snapshot.resolve({ data: response, error: null })
  await settle()
  listener.status("CHANNEL_ERROR")
  listener.status("SUBSCRIBED")
  await settle()
  expect(listener.reads).toBe(4)
  expect(listener.events.map(({ type }) => type)).toEqual([
    "file-request-response",
    "file-request-response.failed",
  ])
  listener.cancel()
  expect(listener.events.at(-1)?.type).toBe("file-request.cancelled")
  listener.actor.stop()
})

for (const outcome of ["accepted", "expired", "cancelled"] as const) {
  test(`reconnect suspends armed expiry until the delayed snapshot is ${outcome}`, async () => {
    jest.useFakeTimers()
    const listener = startListener()
    try {
      const expiresAt = new Date(Date.now() + 1_000).toISOString()
      listener.status("SUBSCRIBED")
      listener.open(expiresAt)
      listener.snapshot.resolve({ data: null, error: null })
      await settle()
      expect(jest.getTimerCount()).toBe(1)
      jest.advanceTimersByTime(500)
      listener.status("CHANNEL_ERROR")
      listener.nextSnapshot()
      listener.status("SUBSCRIBED")
      listener.requestSnapshot.resolve({
        data: {
          cancelled_at: outcome === "cancelled" ? expiresAt : null,
          expires_at: expiresAt,
        },
        error: null,
      })
      await settle()
      jest.advanceTimersByTime(1_000)
      expect(listener.events).toEqual([
        { type: "file-request-response.failed" },
      ])
      listener.snapshot.resolve({
        data: outcome === "expired" ? null : response,
        error: null,
      })
      await settle()
      jest.advanceTimersByTime(1)
      await settle()
      expect(listener.events).toEqual([
        { type: "file-request-response.failed" },
        outcome === "accepted" ?
          { type: "file-request-response", response }
        : {
            type: `file-request.${outcome}`,
            requestId: response.request_id,
          },
      ])
      listener.actor.stop()
      expect(jest.getTimerCount()).toBe(0)
      expect(listener.signal?.aborted).toBe(true)
    } finally {
      listener.actor.stop()
      jest.useRealTimers()
    }
  })
}

test("reconnect with armed expiry still bounds a stalled snapshot read", async () => {
  jest.useFakeTimers()
  const listener = startListener()
  try {
    listener.status("SUBSCRIBED")
    listener.open(new Date(Date.now() + 1_000).toISOString())
    listener.snapshot.resolve({ data: null, error: null })
    await settle()
    listener.nextSnapshot()
    listener.status("SUBSCRIBED")
    jest.advanceTimersByTime(15_000)
    expect(listener.events).toEqual([{ type: "file-request-response.failed" }])
    expect(listener.signal?.aborted).toBe(true)
    listener.actor.stop()
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    listener.actor.stop()
    jest.useRealTimers()
  }
})
