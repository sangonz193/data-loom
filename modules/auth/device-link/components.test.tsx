import "../radix-test-setup"

import { AuthApiError, type User } from "@supabase/supabase-js"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTRPCClient, httpLink } from "@trpc/client"
import { expect, mock, spyOn, test } from "bun:test"
import { Window, type HTMLInputElement } from "happy-dom"
import { act, StrictMode, type ReactNode } from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import superjson from "superjson"

import AccountPage from "@/app/account/page"
import { TRPCProvider } from "@/modules/api/client"
import type { AppRouter } from "@/modules/api/router"
import * as deviceHook from "@/modules/connections/use-device"
import * as browserClient from "@/utils/supabase/client"

import { Account } from "../account/account"
import { AddDevice } from "../account/add-device"
import { AuthProviderClient } from "../provider/client"
import { RequiredAuthClient } from "../required"
import { lockHarness } from "../test-locks"
import * as isolatedAuth from "./isolated-auth"
import { LinkDevice } from "./link-device"
import { DeviceLinkProvider } from "./provider"
import * as setupLinks from "./setup-link"

async function mounted({
  user,
  content,
  rpcError,
  url = "http://localhost:3037/account",
  codeCreatedAt,
  hydrate = false,
  cachedDevice = false,
  setSession = mock(async () => ({
    data: { session: { user: { id: "A" } } },
    error: null,
  })),
}: {
  user: User | null
  content: ReactNode
  rpcError?: string
  url?: string
  codeCreatedAt?: string
  hydrate?: boolean
  cachedDevice?: boolean
  setSession?: ReturnType<typeof mock>
}) {
  const window = new Window({ url })
  const locks = lockHarness()
  const replace = mock(() => {})
  const state = { __NA: true }
  const location = {
    ...window.location,
    replace,
    reload: mock(() => {}),
    hash: window.location.hash,
    pathname: window.location.pathname,
    search: window.location.search,
    origin: window.location.origin,
  }
  const replaceState = mock((_state: unknown, _title: string, path: string) => {
    window.history.replaceState(state, "", path)
    location.hash = window.location.hash
  })
  const globals = {
    window,
    document: window.document,
    FormData: window.FormData,
    navigator: { locks: locks.locks("component") },
    location,
    history: { state, replaceState },
    localStorage: window.localStorage,
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
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const calls = [] as string[]
  const inputs = [] as unknown[]
  const api = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://localhost/api/trpc",
        transformer: superjson,
        fetch: async (input, init) => {
          const path = String(input).split("/api/trpc/")[1]!.split("?")[0]!
          calls.push(path)
          if (path === "devices.link" && typeof init?.body === "string")
            inputs.push(superjson.parse(init.body))
          if (path === "devices.link" && rpcError)
            return Response.json(
              {
                error: superjson.serialize({
                  message: rpcError,
                  code: -32004,
                  data: { code: rpcError, httpStatus: 404 },
                }),
              },
              { status: 404 },
            )
          const value =
            path === "pairing.create" ?
              {
                code: "ABCDEFGH",
                created_at: codeCreatedAt ?? new Date().toISOString(),
              }
            : path === "devices.register" ? { id: "device", personId: "person" }
            : undefined
          return Response.json({ result: { data: superjson.serialize(value) } })
        },
      }),
    ],
  })
  const signIn = mock(async () => ({ error: null }))
  const client = {
    auth: {
      getUser: async () => ({
        data: { user },
        error:
          user ? null : (
            new AuthApiError("User no longer exists", 403, "user_not_found")
          ),
      }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe() {} } },
      }),
      signInWithPassword: signIn,
      setSession,
    },
  } as unknown as ReturnType<typeof browserClient.createClient>
  const spy = spyOn(browserClient, "createClient").mockReturnValue(client)
  const parseSpy = spyOn(setupLinks, "parseSetupLink")
  const deviceSpy =
    cachedDevice ?
      spyOn(deviceHook, "useDevice").mockReturnValue({
        device: { id: "device", personId: "person" },
        error: false,
        retry: () => {},
      })
    : undefined
  const container = window.document.createElement("div")
  window.document.body.append(container)
  function tree(content: ReactNode) {
    return (
      <StrictMode>
        <QueryClientProvider client={query}>
          <TRPCProvider trpcClient={api} queryClient={query}>
            <DeviceLinkProvider>
              <AuthProviderClient initialUser={user} client={client}>
                {content}
              </AuthProviderClient>
            </DeviceLinkProvider>
          </TRPCProvider>
        </QueryClientProvider>
      </StrictMode>
    )
  }
  let serverHtml = ""
  if (hydrate) {
    for (const key of ["window", "document", "location", "history"])
      Reflect.deleteProperty(globalThis, key)
    try {
      serverHtml = renderToString(tree(content))
    } finally {
      for (const key of ["window", "document", "location", "history"] as const)
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value: globals[key],
        })
    }
    expect(renderToString(tree(content))).toBe(serverHtml)
    container.innerHTML = serverHtml
  }
  const hydrationErrors = [] as unknown[]
  let root: ReturnType<typeof createRoot>
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  async function render(content: ReactNode) {
    await act(async () => {
      root.render(tree(content))
      await settle()
    })
  }
  if (hydrate) {
    await act(async () => {
      root = hydrateRoot(container as unknown as HTMLElement, tree(content), {
        onRecoverableError: (error) => hydrationErrors.push(error),
      })
      await settle()
    })
  } else {
    root = createRoot(container as unknown as HTMLElement)
    await render(content)
  }
  return {
    serverHtml,
    hydrationErrors,
    render,
    locks,
    window,
    container,
    calls,
    inputs,
    parseSpy,
    signIn,
    replace,
    replaceState,
    async editCode(value: string) {
      const input = container.querySelector<HTMLInputElement>("#setup-code")!
      await act(async () => {
        // React loaded without a DOM uses its keyup-based input fallback.
        Object.assign(input, { attachEvent() {}, detachEvent() {} })
        input.focus()
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value)
        input.dispatchEvent(new window.Event("input", { bubbles: true }))
        input.dispatchEvent(
          new window.KeyboardEvent("keyup", {
            bubbles: true,
            key: value.at(-1),
          }),
        )
        input.blur()
        await settle()
      })
    },
    async click(text: string) {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === text,
      )!
      expect(button).toBeDefined()
      await act(async () => {
        button.click()
        await settle()
      })
    },
    async submit() {
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(
            new window.Event("submit", { bubbles: true, cancelable: true }),
          )
        await settle()
      })
    },
    async close() {
      await act(async () => root.unmount())
      query.clear()
      locks.destroy("component")
      spy.mockRestore()
      parseSpy.mockRestore()
      deviceSpy?.mockRestore()
      await window.happyDOM.close()
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test("Account setup codes are created only by explicit clicks under StrictMode", async () => {
  const m = await mounted({
    user: { id: "A", is_anonymous: false } as User,
    content: <AddDevice email="a@example.test" />,
  })
  try {
    expect(m.calls).toEqual([])
    expect(m.container.querySelector('svg[role="img"]')).toBeNull()
    await m.click("Get setup code")
    expect(m.calls).toEqual(["pairing.create"])
    expect(m.container.textContent).toContain("ABCDEFGH")
    expect(m.container.textContent).toContain("a@example.test")
    expect(m.container.querySelector('svg[role="img"]')).not.toBeNull()
    await m.click("New code (replaces previous code)")
    expect(m.calls).toEqual(["pairing.create", "pairing.create"])
  } finally {
    await m.close()
  }
})

test("expired setup codes do not display a QR", async () => {
  const m = await mounted({
    user: { id: "A", is_anonymous: false } as User,
    content: <AddDevice email="a@example.test" />,
    codeCreatedAt: "2020-01-01T00:00:00Z",
  })
  try {
    await m.click("Get setup code")
    expect(m.container.querySelector('svg[role="img"]')).toBeNull()
  } finally {
    await m.close()
  }
})

for (const [hash, expected] of [
  ["#setup=ABCDEFGH&hint=a***%40example.test", "ABCDEFGH"],
  ["#setup=ABCDEFG0&hint=a***%40example.test", ""],
]) {
  test(`link screen consumes ${hash} once under StrictMode`, async () => {
    const user = { id: "B", is_anonymous: true } as User
    const m = await mounted({
      user,
      url: `http://localhost:3037/link-device${hash}`,
      content: (
        <RequiredAuthClient user={user}>
          <LinkDevice />
        </RequiredAuthClient>
      ),
    })
    try {
      expect(
        m.container.querySelector<HTMLInputElement>("#setup-code")?.value,
      ).toBe(expected)
      expect(m.replaceState).toHaveBeenCalledTimes(1)
      expect(m.replaceState).toHaveBeenCalledWith(
        { __NA: true },
        "",
        "/link-device",
      )
      expect(m.calls).not.toContain("devices.link")
      if (expected)
        expect(m.container.textContent).toContain(
          "Code filled in from the QR code",
        )
    } finally {
      await m.close()
    }
  })
}

test("permanent link guard makes no device or pairing calls", async () => {
  const user = { id: "A", is_anonymous: false, email: "a@example.test" } as User
  const m = await mounted({
    user,
    url: "http://localhost:3037/link-device#setup=ABCDEFGH",
    content: (
      <RequiredAuthClient user={user}>
        <LinkDevice />
      </RequiredAuthClient>
    ),
  })
  try {
    expect(m.calls).toEqual([])
    expect(m.replaceState).toHaveBeenCalledTimes(1)
    expect(m.container.textContent).toContain(
      "Already signed in as a@example.test",
    )
  } finally {
    await m.close()
  }
})

for (const hydrate of [false, true]) {
  for (const cachedDevice of [false, true]) {
    test(`QR prefill survives ${hydrate ? "hydration" : "mount"} with ${cachedDevice ? "cached" : "immediate"} registration`, async () => {
      const user = { id: "B", is_anonymous: true } as User
      const content = (
        <RequiredAuthClient user={user}>
          <LinkDevice />
        </RequiredAuthClient>
      )
      const m = await mounted({
        user,
        content,
        hydrate,
        cachedDevice,
        url: "http://localhost:3037/link-device?source=test#setup=ABCDEFGH&hint=a***%40example.test",
      })
      try {
        if (hydrate) {
          expect(m.serverHtml).toContain("Registering this browser")
          expect(m.serverHtml).not.toContain("ABCDEFGH")
          expect(m.hydrationErrors).toEqual([])
        }
        expect(
          m.container.querySelector<HTMLInputElement>("#setup-code")?.value,
        ).toBe("ABCDEFGH")
        expect(m.replaceState).toHaveBeenCalledTimes(1)
        expect(m.replaceState).toHaveBeenCalledWith(
          { __NA: true },
          "",
          "/link-device?source=test",
        )
        expect(m.window.location.hash).toBe("")
        expect(m.calls).not.toContain("devices.link")
        expect(m.parseSpy).toHaveBeenCalledTimes(1)
        await m.render(content)
        expect(
          m.container.querySelector<HTMLInputElement>("#setup-code")?.value,
        ).toBe("ABCDEFGH")
        await m.submit()
        expect(m.container.textContent).toContain(
          "looks like a***@example.test",
        )
        expect(
          m.container.querySelector<HTMLInputElement>("#link-email")?.value,
        ).toBe("")
        expect(m.calls.filter((path) => path === "devices.link")).toHaveLength(
          1,
        )
        expect(m.inputs).toEqual([{ code: "ABCDEFGH" }])
      } finally {
        await m.close()
      }
    })
  }
}

test("permanent link screen renders on the server and hydrates while ignoring the fragment", async () => {
  const user = { id: "A", is_anonymous: false, email: "a@example.test" } as User
  const m = await mounted({
    user,
    hydrate: true,
    url: "http://localhost:3037/link-device#setup=ABCDEFGH&hint=b***%40other.test",
    content: (
      <RequiredAuthClient user={user}>
        <LinkDevice />
      </RequiredAuthClient>
    ),
  })
  try {
    expect(m.serverHtml).toContain("Already signed in as")
    expect(m.hydrationErrors).toEqual([])
    expect(m.container.textContent).not.toContain("ABCDEFGH")
    expect(m.container.textContent).not.toContain("other.test")
    expect(m.calls).toEqual([])
    expect(m.parseSpy).not.toHaveBeenCalled()
    expect(m.replaceState).toHaveBeenCalledTimes(1)
  } finally {
    await m.close()
  }
})

for (const change of ["edit", "choose"] as const) {
  test(`${change} clears QR attribution and hint without overwriting manual input`, async () => {
    const user = { id: "B", is_anonymous: true } as User
    const content = (
      <RequiredAuthClient user={user}>
        <LinkDevice />
      </RequiredAuthClient>
    )
    const m = await mounted({
      user,
      content,
      hydrate: true,
      cachedDevice: true,
      url: "http://localhost:3037/link-device#setup=ABCDEFGH&hint=a***%40example.test",
    })
    try {
      if (change === "choose") {
        await m.submit()
        expect(m.container.textContent).toContain(
          "looks like a***@example.test",
        )
        await m.click("Use a different code")
      } else {
        await m.editCode("ZXCV2345")
      }
      expect(m.container.textContent).not.toContain(
        "Code filled in from the QR code",
      )
      await m.render(content)
      expect(
        m.container.querySelector<HTMLInputElement>("#setup-code")?.value,
      ).toBe(change === "edit" ? "ZXCV2345" : "ABCDEFGH")
      expect(m.replaceState).toHaveBeenCalledTimes(1)
      await m.submit()
      expect(m.container.textContent).not.toContain("looks like")
      expect(m.inputs.at(-1)).toEqual({
        code: change === "edit" ? "ZXCV2345" : "ABCDEFGH",
      })
      expect(
        m.container.querySelector<HTMLInputElement>("#link-email")?.value,
      ).toBe("")
    } finally {
      await m.close()
    }
  })
}

for (const [code, message] of [
  ["NOT_FOUND", "Code not found or expired"],
  ["FORBIDDEN", "already used on another device"],
]) {
  test(`anonymous link screen reports ${code} before requesting credentials`, async () => {
    const user = { id: "B", is_anonymous: true } as User
    const m = await mounted({
      user,
      rpcError: code,
      content: (
        <RequiredAuthClient user={user}>
          <LinkDevice />
        </RequiredAuthClient>
      ),
    })
    try {
      await m.submit()
      expect(m.container.textContent).toContain(message!)
      expect(m.container.querySelector('input[type="password"]')).toBeNull()
      expect(m.calls.filter((path) => path === "devices.link")).toHaveLength(1)
    } finally {
      await m.close()
    }
  })
}

test("Account route mounts sign-in with null user and dead B credentials and can recover explicitly", async () => {
  const page = await AccountPage({ searchParams: Promise.resolve({}) })
  const m = await mounted({ user: null, content: page })
  try {
    expect(m.container.textContent).toContain("Sign in")
    expect(
      m.container.querySelector('a[href="/link-device"]')?.textContent,
    ).toContain("Link this browser")
    expect(m.container.textContent).not.toContain("Get setup code")
    expect(m.calls).toEqual([])
    expect(m.replace).not.toHaveBeenCalled()
    m.container.querySelector<HTMLInputElement>('input[name="email"]')!.value =
      "a@example.test"
    m.container.querySelector<HTMLInputElement>(
      'input[name="password"]',
    )!.value = "password"
    await m.submit()
    expect(m.signIn).toHaveBeenCalledWith({
      email: "a@example.test",
      password: "password",
    })
    expect(m.replace).toHaveBeenCalledWith("/home")
  } finally {
    await m.close()
  }
})

test("permanent Account retains its setup-code panel", async () => {
  const m = await mounted({
    user: { id: "A", is_anonymous: false } as User,
    content: <Account />,
  })
  try {
    expect(m.container.textContent).toContain("Get setup code")
    expect(m.container.querySelector('a[href="/link-device"]')).toBeNull()
  } finally {
    await m.close()
  }
})

for (const phase of ["ambiguous", "install", "in-flight"] as const) {
  test(`route unmount during ${phase} linking preserves reachable retry and blocks other-tab auth and registration`, async () => {
    const user = { id: "B", is_anonymous: true } as User
    let identity = "B"
    let committed = phase === "install"
    const response = Promise.withResolvers<void>()
    const complete = mock(async () => {
      if (phase === "in-flight") await response.promise
      if (phase !== "install") throw new TypeError("lost response")
    })
    const signOut = mock(async () => ({ error: null }))
    const dispose = mock(() => {})
    const isolatedSignIn = mock(async () => ({ error: null }))
    const isolated = spyOn(isolatedAuth, "createIsolatedAuth").mockReturnValue({
      client: {
        auth: { signInWithPassword: isolatedSignIn, signOut, dispose },
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: committed ? { id: "device" } : null,
                error: null,
              }),
            }),
          }),
        }),
      },
      api: { devices: { completeLink: { mutate: complete } } },
      session: async () => ({
        access_token: "a-token",
        refresh_token: "a-refresh",
      }),
    } as unknown as ReturnType<typeof isolatedAuth.createIsolatedAuth>)
    const install = mock(async () => {
      identity = "A"
      return { data: { session: { user: { id: "A" } } }, error: null }
    })
    if (phase === "install")
      install.mockRejectedValueOnce(new TypeError("offline"))
    const page = (
      <RequiredAuthClient user={user}>
        <LinkDevice />
      </RequiredAuthClient>
    )
    const m = await mounted({ user, content: page, setSession: install })
    try {
      await m.submit()
      await m.submit()
      if (phase !== "in-flight")
        expect(m.container.textContent).toContain("Retry check")
      const register = mock(async () => {})
      const signIn = mock(async () => {})
      const other = m.locks.tab("other")
      const registration = other.transitions.withIdentity(
        "B",
        async () => identity,
        register,
      )
      const login = other.transitions.run(signIn)

      await m.render(<Account />)
      expect(m.container.querySelector("#link-password")).toBeNull()
      expect(
        m.container.querySelector('[aria-label="Browser linking"]'),
      ).not.toBeNull()
      if (phase === "in-flight") {
        await act(async () => {
          response.resolve()
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
      }
      expect(m.container.textContent).toContain("Retry check")
      expect(register).not.toHaveBeenCalled()
      expect(signIn).not.toHaveBeenCalled()
      expect(signOut).not.toHaveBeenCalled()
      expect(dispose).not.toHaveBeenCalled()
      expect(m.replace).not.toHaveBeenCalled()
      expect(identity).toBe("B")

      await m.render(page)
      expect(m.container.textContent).toContain("Registering this browser")
      expect(isolatedSignIn).toHaveBeenCalledTimes(1)
      expect(m.calls.filter((path) => path === "devices.link")).toHaveLength(1)
      await m.render(<Account />)
      committed = true
      await m.click("Retry check")
      expect(identity).toBe("A")
      expect(m.replace).toHaveBeenCalledWith("/home")
      expect(signOut).not.toHaveBeenCalled()
      expect(register).not.toHaveBeenCalled()
      expect(signIn).not.toHaveBeenCalled()
      m.locks.destroy("component")
      await registration
      await login
      expect(register).not.toHaveBeenCalled()
      expect(signIn).toHaveBeenCalledTimes(1)
    } finally {
      response.resolve()
      await m.close()
      isolated.mockRestore()
    }
  })
}

test("anonymous Account offers linking and never generates a setup code", async () => {
  const m = await mounted({
    user: { id: "B", is_anonymous: true } as User,
    content: <Account />,
  })
  try {
    expect(
      m.container.querySelector('a[href="/link-device"]')?.textContent,
    ).toContain("Link this browser")
    expect(m.container.textContent).not.toContain("Get setup code")
    expect(m.calls).toEqual([])
  } finally {
    await m.close()
  }
})
