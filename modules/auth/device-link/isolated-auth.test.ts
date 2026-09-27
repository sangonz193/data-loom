import { createClient } from "@supabase/supabase-js"
import { expect, jest, mock, spyOn, test } from "bun:test"
import superjson from "superjson"

import { createIsolatedAuth, createIsolatedFetch } from "./isolated-auth"

function session(id: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const access_token =
    [
      { alg: "HS256", typ: "JWT" },
      { sub: id, exp },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".") + ".c2lnbmF0dXJl"
  return {
    access_token,
    refresh_token: `refresh-${id}`,
    expires_in: 3600,
    token_type: "bearer",
    user: { id, is_anonymous: id === "B" },
  }
}

test("isolated SDK keeps credentials in memory and all auth, read and Bearer requests omit cookies", async () => {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, "any")!
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    value: undefined,
  })
  const requests = [] as { url: string; init?: RequestInit }[]
  const a = session("A")
  const isolated = createIsolatedAuth({
    url: "http://localhost:59321",
    key: "test-key",
    apiUrl: "http://localhost:3037/api/trpc",
    fetcher: (async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes("/token")) return Response.json(a)
      if (url.includes("/logout")) return new Response(null, { status: 204 })
      if (url.includes("/devices.completeLink"))
        return Response.json({
          result: { data: superjson.serialize(undefined) },
        })
      if (url.includes("/rest/v1/devices"))
        return Response.json({ id: "device" })
      throw new Error("Unexpected request")
    }) as typeof fetch,
  })
  try {
    expect(Reflect.get(isolated.client.auth, "persistSession")).toBe(false)
    expect(Reflect.get(isolated.client.auth, "autoRefreshToken")).toBe(false)
    expect(Reflect.get(isolated.client.auth, "detectSessionInUrl")).toBe(false)
    expect(Reflect.get(isolated.client.auth, "storageKey")).toBe(
      "data-loom-device-link",
    )
    expect(Reflect.get(isolated.client.auth, "broadcastChannel")).toBeNull()
    expect(
      (
        await isolated.client.auth.signInWithPassword({
          email: "a@example.test",
          password: "password",
        })
      ).error,
    ).toBeNull()
    await isolated.api.devices.completeLink.mutate({
      code: "ABCDEFGH",
      deviceId: crypto.randomUUID(),
    })
    expect(
      (await isolated.client.from("devices").select("id").maybeSingle()).error,
    ).toBeNull()
    await isolated.client.auth.signOut({ scope: "local" })
    expect(requests).toHaveLength(4)
    for (const { init } of requests) {
      expect(init?.credentials).toBe("omit")
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(new Headers(init?.headers).has("cookie")).toBe(false)
    }
    const completion = requests.find(({ url }) =>
      url.includes("devices.completeLink"),
    )!
    expect(new Headers(completion.init?.headers).get("authorization")).toBe(
      `Bearer ${a.access_token}`,
    )
  } finally {
    Object.defineProperty(AbortSignal, "any", any)
    isolated.client.auth.dispose()
  }
})

for (const outcome of [
  "success",
  "failure",
  "caller",
  "already-aborted",
  "timeout",
  "request-signal",
] as const) {
  test(`isolated fetch ${outcome} preserves abort reasons and removes timers and listeners`, async () => {
    jest.useFakeTimers()
    const caller = new AbortController()
    const reason = new DOMException("Cancelled by caller", "AbortError")
    if (outcome === "already-aborted") caller.abort(reason)
    const input =
      outcome === "request-signal" ?
        new Request("http://localhost/test", { signal: caller.signal })
      : "http://localhost/test"
    const signal = input instanceof Request ? input.signal : caller.signal
    const add = spyOn(signal, "addEventListener")
    const remove = spyOn(signal, "removeEventListener")
    const result = Promise.withResolvers<Response>()
    const failure = new TypeError("offline")
    const transport = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init!.signal!
      if (signal.aborted) result.reject(signal.reason)
      else
        signal.addEventListener("abort", () => result.reject(signal.reason), {
          once: true,
        })
      return result.promise
    })
    try {
      const request = createIsolatedFetch(transport as typeof fetch)(
        input,
        outcome === "request-signal" ? undefined : { signal },
      )
      const settled = request.then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      )
      expect(transport).toHaveBeenCalledTimes(1)
      expect(transport.mock.calls[0]![1]!.credentials).toBe("omit")
      expect(jest.getTimerCount()).toBe(1)
      if (outcome === "success") result.resolve(new Response("ok"))
      else if (outcome === "failure") result.reject(failure)
      else if (outcome === "caller" || outcome === "request-signal")
        caller.abort(reason)
      else if (outcome === "timeout") {
        jest.advanceTimersByTime(14_999)
        expect(transport.mock.calls[0]![1]!.signal!.aborted).toBe(false)
        jest.advanceTimersByTime(1)
      }
      const response = await settled
      if (outcome === "success") expect(await response.value!.text()).toBe("ok")
      else if (outcome === "failure") expect(response.error).toBe(failure)
      else if (outcome === "timeout")
        expect(response.error).toMatchObject({ name: "TimeoutError" })
      else expect(response.error).toBe(reason)
      expect(jest.getTimerCount()).toBe(0)
      if (outcome === "already-aborted") expect(add).not.toHaveBeenCalled()
      else expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1])
      const combined = transport.mock.calls[0]![1]!.signal!
      caller.abort(reason)
      if (outcome === "success" || outcome === "failure")
        expect(combined.aborted).toBe(false)
      if (outcome === "timeout")
        expect(combined.reason.name).toBe("TimeoutError")
    } finally {
      add.mockRestore()
      remove.mockRestore()
      jest.useRealTimers()
    }
  })
}

test("isolated fetch keeps the deadline through a stalled response body", async () => {
  const timeout = spyOn(globalThis, "setTimeout")
  const clear = spyOn(globalThis, "clearTimeout")
  const caller = new AbortController()
  const add = spyOn(caller.signal, "addEventListener")
  const remove = spyOn(caller.signal, "removeEventListener")
  const transport = mock((_input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            init!.signal!.addEventListener(
              "abort",
              () => controller.error(init!.signal!.reason),
              { once: true },
            )
          },
        }),
      ),
    ),
  )
  try {
    const request = createIsolatedFetch(transport as typeof fetch)(
      "http://localhost/test",
      { signal: caller.signal },
    )
    const rejected = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
    })
    expect(timeout.mock.calls[0]![1]).toBe(15_000)
    await rejected
    expect(clear).toHaveBeenCalledWith(timeout.mock.results[0]!.value)
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1])
  } finally {
    add.mockRestore()
    remove.mockRestore()
    timeout.mockRestore()
    clear.mockRestore()
  }
}, 20_000)

test("installed SDK discards B's pending refresh after another tab installs A", async () => {
  const storage = new Map<string, string>()
  const refreshing = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const a = session("A")
  const b = session("B")
  const options = {
    auth: {
      storageKey: `refresh-test-${crypto.randomUUID()}`,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value)
        },
        removeItem: (key: string) => {
          storage.delete(key)
        },
      },
    },
    global: {
      fetch: (async (input, init) => {
        if (String(input).includes("/token")) {
          refreshing.resolve()
          await finish.promise
          return Response.json({ ...b, refresh_token: "rotated-B" })
        }
        const token = new Headers(init?.headers).get("authorization")
        return Response.json(
          token === `Bearer ${a.access_token}` ? a.user : b.user,
        )
      }) as typeof fetch,
    },
  }
  const first = createClient("http://localhost:59321", "test-key", options)
  const second = createClient("http://localhost:59321", "test-key", options)
  try {
    expect((await first.auth.setSession(b)).error).toBeNull()
    const pending = first.auth.refreshSession()
    await refreshing.promise
    expect((await second.auth.setSession(a)).error).toBeNull()
    finish.resolve()
    const result = await pending
    expect(result.error?.name).toBe("AuthRefreshDiscardedError")
    expect((await first.auth.getSession()).data.session?.user.id).toBe("A")
  } finally {
    finish.resolve()
    first.auth.dispose()
    second.auth.dispose()
  }
})
