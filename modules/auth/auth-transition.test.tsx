import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  type AuthChangeEvent,
  type AuthError,
  type Session,
  type User,
} from "@supabase/supabase-js"
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { expect, mock, test } from "bun:test"
import { Window } from "happy-dom"
import { act, useEffect } from "react"
import { createRoot } from "react-dom/client"

import { registerDevice } from "@/modules/connections/register-device"
import type { createClient } from "@/utils/supabase/client"

import { ensureSession } from "./anonymous-sign-in"
import {
  createAuthTransitions,
  unsupportedAuthMessage,
} from "./auth-transition"
import { AuthProviderClient } from "./provider/client"
import { useIdentityDevice } from "./use-identity-device"
import { useUser } from "./use-user"

function lockHarness() {
  type Request = { owner: string; shared: boolean; start: () => void }
  const queue = [] as Request[]
  const active = new Set<Request>()
  function drain() {
    while (queue.length) {
      const next = queue[0]!
      if (
        active.size &&
        (!next.shared || [...active].some((entry) => !entry.shared))
      )
        return
      queue.shift()
      active.add(next)
      next.start()
    }
  }
  function locks(owner: string) {
    return {
      request: (
        _name: string,
        options: LockOptions | (() => unknown),
        callback?: () => unknown,
      ) =>
        new Promise<unknown>((resolve, reject) => {
          const fn = typeof options === "function" ? options : callback!
          const entry = {
            owner,
            shared: typeof options !== "function" && options.mode === "shared",
            start: () => {
              void Promise.resolve()
                .then(fn)
                .then(resolve, reject)
                .finally(() => {
                  active.delete(entry)
                  drain()
                })
            },
          }
          queue.push(entry)
          drain()
        }),
    } as LockManager
  }
  return {
    tab: (owner: string) => {
      const replace = mock((path: string) => {
        void path
      })
      const reload = mock(() => {})
      return {
        transitions: createAuthTransitions({
          locks: () => locks(owner),
          replace,
          reload,
        }),
        replace,
        reload,
      }
    },
    destroy: (owner: string) => {
      for (const entry of active)
        if (entry.owner === owner) active.delete(entry)
      for (let i = queue.length - 1; i >= 0; i--)
        if (queue[i]!.owner === owner) queue.splice(i, 1)
      drain()
    },
  }
}

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

test("anonymous sign-in rechecks cookies after real sign-in and navigation releases the document lock", async () => {
  const locks = lockHarness()
  const real = locks.tab("real")
  const anonymous = locks.tab("anonymous")
  let cookieUser: string | null = null
  const signedIn = Promise.withResolvers<void>()
  const signInAnonymously = mock(async () => {
    cookieUser = "anonymous"
    return { error: null }
  })
  const auth = {
    getSession: async () => ({
      data: { session: cookieUser ? { user: { id: cookieUser } } : null },
      error: null,
    }),
    signInAnonymously,
  } as unknown as Parameters<typeof ensureSession>[0]

  void real.transitions.run(async () => {
    await signedIn.promise
    cookieUser = "permanent"
    await real.transitions.navigate("/home")
  })
  const pending = anonymous.transitions.run(() => ensureSession(auth))
  await settle()
  expect(signInAnonymously).not.toHaveBeenCalled()
  signedIn.resolve()
  await settle()
  expect(real.replace).toHaveBeenCalledWith("/home")
  expect(signInAnonymously).not.toHaveBeenCalled()
  let finished = false
  void pending.then(() => {
    finished = true
  })
  await settle()
  expect(finished).toBe(false)
  locks.destroy("real")
  await pending
  expect(signInAnonymously).not.toHaveBeenCalled()
  expect(String(cookieUser)).toBe("permanent")
})

test("anonymous creation holds the lock until navigation before queued password sign-in can write cookies", async () => {
  const locks = lockHarness()
  const anonymous = locks.tab("anonymous")
  const real = locks.tab("real")
  const created = Promise.withResolvers<void>()
  let cookieUser: string | null = null
  const auth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    signInAnonymously: async () => {
      await created.promise
      cookieUser = "anonymous"
      return { error: null }
    },
  } as unknown as Parameters<typeof ensureSession>[0]
  void anonymous.transitions.run(async () => {
    await ensureSession(auth)
    await anonymous.transitions.navigate("/home")
  })
  const login = real.transitions.run(async () => {
    cookieUser = "permanent"
  })
  await settle()
  expect(cookieUser).toBeNull()
  created.resolve()
  await settle()
  expect(String(cookieUser)).toBe("anonymous")
  locks.destroy("anonymous")
  await login
  expect(String(cookieUser)).toBe("permanent")
})

test("failures release the lock and missing Web Locks prevents auth mutations", async () => {
  const locks = lockHarness()
  const tab = locks.tab("one")
  await expect(
    tab.transitions.run(async () => {
      throw new Error("wrong password")
    }),
  ).rejects.toThrow("wrong password")
  const action = mock(async () => {})
  await tab.transitions.run(action)
  expect(action).toHaveBeenCalledTimes(1)
  const unsupported = createAuthTransitions({
    locks: () => undefined,
    replace: () => {},
    reload: () => {},
  })
  await expect(unsupported.run(action)).rejects.toThrow(unsupportedAuthMessage)
  expect(action).toHaveBeenCalledTimes(1)
})

for (const source of [
  "broadcast",
  "focus refetch",
  "same-user upgrade",
  "sign-out",
] as const) {
  test(`mounted provider and device hook keep rendered identity during ${source} and gate queued registration`, async () => {
    const window = new Window({ url: "http://localhost:3000/home" })
    const globals = {
      window,
      document: window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    }
    const previous = Object.fromEntries(
      Object.keys(globals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    )
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      })
    const container = window.document.createElement("div")
    window.document.body.append(container)
    const root = createRoot(container as unknown as HTMLElement)
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    const locks = lockHarness()
    const login = locks.tab("login")
    const home = locks.tab("home")
    const original = { id: "anonymous", is_anonymous: true } as User
    let current: User | null = original
    let callback = (event: AuthChangeEvent, session: Session | null) => {
      void event
      void session
    }
    const client = {
      auth: {
        getUser: async () => ({ data: { user: current }, error: null }),
        onAuthStateChange: (listener: typeof callback) => {
          callback = listener
          return { data: { subscription: { unsubscribe: () => {} } } }
        },
      },
    } as unknown as ReturnType<typeof createClient>
    const storage = new Map([["data-loom-device-id", "retained-device"]])
    const apiRegister = mock(async (id: string) => ({
      id,
      personId: "anonymous-person",
    }))
    const register = () =>
      registerDevice("anonymous", apiRegister, {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value)
        },
      })
    const readId = async () => current?.id
    const seen = [] as string[]
    function Device() {
      const user = useUser()!
      seen.push(user.id)
      const result = useIdentityDevice(
        user.id,
        readId,
        register,
        home.transitions,
      )
      return (
        <span>
          {user.id}:{result.device?.id || "waiting"}
        </span>
      )
    }
    try {
      const swapped = Promise.withResolvers<void>()
      void login.transitions.run(async () => {
        await swapped.promise
        current =
          source === "sign-out" ? null : (
            ({
              id: source === "same-user upgrade" ? original.id : "permanent",
              is_anonymous: false,
            } as User)
          )
        await login.transitions.navigate("/home")
      })
      await act(async () => {
        root.render(
          <QueryClientProvider client={query}>
            <AuthProviderClient
              initialUser={original}
              client={client}
              transitions={home.transitions}
            >
              <Device />
            </AuthProviderClient>
          </QueryClientProvider>,
        )
        await settle()
      })
      expect(apiRegister).not.toHaveBeenCalled()
      await act(async () => {
        callback("INITIAL_SESSION", null)
        swapped.resolve()
        await settle()
        if (source !== "focus refetch") {
          callback(
            source === "sign-out" ? "SIGNED_OUT"
            : source === "same-user upgrade" ? "USER_UPDATED"
            : "SIGNED_IN",
            current ? ({ user: current } as Session) : null,
          )
          await new Promise((resolve) => setTimeout(resolve, 5))
        } else {
          await query.refetchQueries({ queryKey: ["user"] })
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      })
      expect(new Set(seen)).toEqual(new Set(["anonymous"]))
      expect(container.textContent).toBe("anonymous:waiting")
      expect(home.reload).not.toHaveBeenCalled()
      expect(apiRegister).not.toHaveBeenCalled()
      await act(async () => {
        locks.destroy("login")
        await settle()
      })
      if (source === "same-user upgrade") {
        expect(home.reload).not.toHaveBeenCalled()
        expect(apiRegister).toHaveBeenCalledTimes(1)
        await act(async () => {
          callback("TOKEN_REFRESHED", { user: current } as Session)
          await new Promise((resolve) => setTimeout(resolve, 5))
        })
        expect(apiRegister).toHaveBeenCalledTimes(1)
        expect(container.textContent).toBe("anonymous:retained-device")
      } else {
        expect(home.reload).toHaveBeenCalledTimes(1)
        expect(apiRegister).not.toHaveBeenCalled()
      }
      expect(storage.get("data-loom-device-id")).toBe("retained-device")
    } finally {
      await act(async () => root.unmount())
      query.clear()
      locks.destroy("home")
      locks.destroy("login")
      await window.happyDOM.close()
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  })
}

for (const confirmation of ["changed identity", "missing session"] as const) {
  test(`auth lookup failures preserve the mounted user and device until ${confirmation} is confirmed`, async () => {
    const window = new Window({ url: "http://localhost:3000/home" })
    const globals = {
      window,
      document: window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    }
    const previous = Object.fromEntries(
      Object.keys(globals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    )
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      })
    const container = window.document.createElement("div")
    window.document.body.append(container)
    const root = createRoot(container as unknown as HTMLElement)
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    const locks = lockHarness()
    const home = locks.tab("home")
    const login = locks.tab("login")
    const original = { id: "anonymous", is_anonymous: true } as User
    let current: User | null = original
    let error: AuthError | null = new AuthRetryableFetchError("Offline", 0)
    let callback = (event: AuthChangeEvent, session: Session | null) => {
      void event
      void session
    }
    const getUser = mock(async () => ({
      data: { user: error ? null : current },
      error,
    }))
    const client = {
      auth: {
        getUser,
        onAuthStateChange: (listener: typeof callback) => {
          callback = listener
          return { data: { subscription: { unsubscribe: () => {} } } }
        },
      },
    } as unknown as ReturnType<typeof createClient>
    const storage = new Map([["data-loom-device-id", "retained-device"]])
    const setItem = mock((key: string, value: string) => {
      storage.set(key, value)
    })
    const apiRegister = mock(async (id: string) => ({
      id,
      personId: "anonymous-person",
    }))
    const register = () =>
      registerDevice(original.id, apiRegister, {
        getItem: (key) => storage.get(key) ?? null,
        setItem,
      })
    const readId = async () => current?.id
    const transferMounted = mock(() => {})
    const transferUnmounted = mock(() => {})
    function Transfer() {
      const user = useUser()!
      const result = useIdentityDevice(
        user.id,
        readId,
        register,
        home.transitions,
      )
      useEffect(() => {
        transferMounted()
        return transferUnmounted
      }, [])
      return (
        <span>
          {user.id}:{result.device?.id || "waiting"}
        </span>
      )
    }
    const focused = focusManager.isFocused()
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={query}>
            <AuthProviderClient
              initialUser={original}
              client={client}
              transitions={home.transitions}
            >
              <Transfer />
              <input defaultValue="unsaved form" />
            </AuthProviderClient>
          </QueryClientProvider>,
        )
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      expect(query.getQueryState(["user"])?.error).toBe(error)
      expect(home.reload).not.toHaveBeenCalled()
      expect(container.textContent).toBe("anonymous:retained-device")
      const form = container.querySelector("input")!
      form.value = "edited form"

      error = null
      await act(async () => {
        await query.refetchQueries({ queryKey: ["user"] })
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      expect(query.getQueryData<User>(["user"])).toBe(original)
      for (const source of ["refetch", "focus", "token refresh"] as const) {
        error =
          source === "refetch" ? new AuthRetryableFetchError("Offline", 0)
          : source === "focus" ? new AuthRetryableFetchError("Unavailable", 503)
          : new AuthApiError("Rate limited", 429, "over_request_rate_limit")
        const calls = getUser.mock.calls.length
        await act(async () => {
          if (source === "refetch")
            await query.refetchQueries({ queryKey: ["user"] })
          else if (source === "focus") {
            focusManager.setFocused(false)
            focusManager.setFocused(true)
          } else callback("TOKEN_REFRESHED", { user: original } as Session)
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
        expect(getUser.mock.calls.length).toBeGreaterThan(calls)
        expect(query.getQueryState(["user"])?.error).toBe(error)
        expect(query.getQueryData<User>(["user"])).toBe(original)
        expect(home.reload).not.toHaveBeenCalled()
        expect(apiRegister).toHaveBeenCalledTimes(1)
        expect(setItem).not.toHaveBeenCalled()
        expect(storage.get("data-loom-device-id")).toBe("retained-device")
        expect(transferMounted).toHaveBeenCalledTimes(1)
        expect(transferUnmounted).not.toHaveBeenCalled()
        expect(container.textContent).toBe("anonymous:retained-device")
        expect(container.querySelector("input")).toBe(form)
        expect(form.value).toBe("edited form")
      }

      void login.transitions.run(() => new Promise<never>(() => {}))
      await settle()
      current =
        confirmation === "changed identity" ?
          ({ id: "permanent" } as User)
        : null
      error =
        confirmation === "missing session" ?
          new AuthSessionMissingError()
        : null
      await act(async () => {
        await query.refetchQueries({ queryKey: ["user"] })
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      expect(query.getQueryState(["user"])?.error).toBeNull()
      expect(query.getQueryData<User | null>(["user"])).toEqual(current)
      expect(home.reload).not.toHaveBeenCalled()
      expect(transferUnmounted).not.toHaveBeenCalled()
      await act(async () => {
        locks.destroy("login")
        await settle()
      })
      expect(home.reload).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
      query.clear()
      focusManager.setFocused(focused)
      locks.destroy("home")
      locks.destroy("login")
      await window.happyDOM.close()
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    }
  })
}

test("a device registration already in flight finishes before an identity transition", async () => {
  const locks = lockHarness()
  const home = locks.tab("home")
  const login = locks.tab("login")
  const registered = Promise.withResolvers<void>()
  let current = "anonymous"
  const registration = home.transitions.withIdentity(
    "anonymous",
    async () => current,
    async () => {
      await registered.promise
      return "retained-device"
    },
  )
  const swap = login.transitions.run(async () => {
    current = "permanent"
  })
  await settle()
  expect(current).toBe("anonymous")
  registered.resolve()
  expect(await registration).toBe("retained-device")
  await swap
  expect(current).toBe("permanent")
})
