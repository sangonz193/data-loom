import "../radix-test-setup"

import type { User } from "@supabase/supabase-js"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTRPCClient, httpLink } from "@trpc/client"
import { expect, mock, spyOn, test } from "bun:test"
import { Window } from "happy-dom"
import { act, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import superjson from "superjson"

import { TRPCProvider } from "@/modules/api/client"
import type { AppRouter } from "@/modules/api/router"
import * as browserClient from "@/utils/supabase/client"

import { AuthProviderClient } from "../provider/client"
import { RequiredAuthClient } from "../required"
import { lockHarness } from "../test-locks"

const currentId = "11111111-1111-4111-8111-111111111111"
const otherId = "22222222-2222-4222-8222-222222222222"

async function mounted(
  options: {
    user?: User | null
    rows?: { id: string; name: string; last_seen_at: string }[]
    registerError?: string
    listError?: boolean
    renameError?: string
    removeError?: string
    account?: boolean
  } = {},
) {
  const user =
    options.user === undefined ?
      ({
        id: "owner",
        email: "owner@example.test",
        is_anonymous: false,
      } as User)
    : options.user
  const window = new Window({ url: "http://localhost:3037/account" })
  const locks = lockHarness()
  const globals = {
    window,
    document: window.document,
    FormData: window.FormData,
    navigator: {
      userAgent: "Mozilla/5.0 Chrome/120.0 Macintosh",
      locks: locks.locks("devices"),
    },
    location: { reload: mock(() => {}), replace: mock(() => {}) },
    localStorage: window.localStorage,
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    Node: window.Node,
    Element: window.Element,
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
  const { Account } = await import("./account")
  const { Devices } = await import("./devices")
  window.localStorage.setItem("data-loom-device-id", currentId)
  const query = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  const calls: { path: string; input: unknown }[] = []
  let rows = options.rows ?? [
    { id: otherId, name: "Firefox", last_seen_at: "2026-09-27T10:00:00Z" },
    { id: currentId, name: "Chrome", last_seen_at: "2026-09-26T10:00:00Z" },
  ]
  let listError = !!options.listError
  let listCalls = 0
  const api = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://localhost/api/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          const path = String(url).split("/api/trpc/")[1]!.split("?")[0]!
          const input = (
            JSON.parse(String(init?.body)) as {
              json: { id?: string; name?: string }
            }
          ).json
          calls.push({ path, input })
          const code =
            path === "devices.register" ? options.registerError
            : path === "devices.rename" ? options.renameError
            : path === "devices.remove" ? options.removeError
            : undefined
          if (code)
            return Response.json(
              {
                error: superjson.serialize({
                  message: code,
                  code: -32004,
                  data: { code, httpStatus: code === "NOT_FOUND" ? 404 : 500 },
                }),
              },
              { status: code === "NOT_FOUND" ? 404 : 500 },
            )
          if (path === "devices.rename")
            rows = rows.map((row) =>
              row.id === input.id ?
                { ...row, name: input.name ?? row.name }
              : row,
            )
          if (path === "devices.remove")
            rows = rows.filter((row) => row.id !== input.id)
          const value =
            path === "devices.register" ? { id: currentId, personId: "person" }
            : path === "devices.rename" ? { id: input.id, name: input.name }
            : undefined
          return Response.json({ result: { data: superjson.serialize(value) } })
        },
      }),
    ],
  })
  const client = {
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe() {} } },
      }),
    },
    from: () => ({
      select: () => {
        listCalls++
        return {
          order: () => ({
            order: async () => ({
              data: listError ? null : rows,
              error: listError ? Error("query failed") : null,
            }),
          }),
        }
      },
    }),
  } as unknown as ReturnType<typeof browserClient.createClient>
  const spy = spyOn(browserClient, "createClient").mockReturnValue(client)
  const container = window.document.createElement("div")
  window.document.body.append(container)
  const root = createRoot(container as unknown as HTMLElement)
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={query}>
          <TRPCProvider trpcClient={api} queryClient={query}>
            <AuthProviderClient initialUser={user} client={client}>
              {options.account ?
                <Account />
              : user ?
                <RequiredAuthClient user={user}>
                  <Devices />
                </RequiredAuthClient>
              : null}
            </AuthProviderClient>
          </TRPCProvider>
        </QueryClientProvider>
      </StrictMode>,
    )
    await settle()
  })
  for (
    let attempt = 0;
    attempt < 5 && container.textContent?.includes("Loading devices");
    attempt++
  )
    await act(settle)
  return {
    calls,
    get listCalls() {
      return listCalls
    },
    container,
    window,
    async click(label: string, index = 0) {
      const button = [
        ...window.document.body.querySelectorAll("button"),
      ].filter((item) => item.textContent === label)[index]
      expect(button).toBeDefined()
      await act(async () => {
        button!.click()
        await settle()
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
    },
    async submit(name: string) {
      const input = container.querySelector('input[id^="device-name-"]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, name)
        input.dispatchEvent(new window.Event("input", { bubbles: true }))
        await settle()
      })
      await act(async () => {
        input
          .closest("form")!
          .dispatchEvent(
            new window.Event("submit", { bubbles: true, cancelable: true }),
          )
        await settle()
      })
    },
    async retryList() {
      listError = false
      await this.click("Retry")
    },
    async close() {
      await act(async () => root.unmount())
      query.clear()
      locks.destroy("devices")
      spy.mockRestore()
      await window.happyDOM.close()
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test("current browser is first and cannot be removed", async () => {
  const m = await mounted()
  try {
    expect(
      m.calls.filter((call) => call.path === "devices.register"),
    ).toHaveLength(1)
    expect(m.container.querySelector("li")?.textContent).toContain(
      "This browser",
    )
    expect(m.container.querySelector("li")?.textContent).toContain("Chrome")
    expect(m.container.querySelector("li")?.textContent).not.toContain("Remove")
    expect(m.container.textContent).toContain("Last seen")
  } finally {
    await m.close()
  }
})

test("empty state and registration failure", async () => {
  const empty = await mounted({
    rows: [
      { id: currentId, name: "Chrome", last_seen_at: "2026-09-27T10:00:00Z" },
    ],
  })
  try {
    expect(empty.container.textContent).toContain("No other devices yet.")
  } finally {
    await empty.close()
  }
  const failed = await mounted({ registerError: "FORBIDDEN" })
  try {
    expect(failed.container.textContent).toContain(
      "Couldn’t register this browser.",
    )
    expect(
      failed.calls.filter((call) => call.path === "devices.register"),
    ).toHaveLength(1)
    expect(failed.listCalls).toBe(0)
  } finally {
    await failed.close()
  }
})

test("rename succeeds and refreshes the list", async () => {
  const m = await mounted()
  try {
    await m.click("Rename", 1)
    await m.submit("Laptop")
    expect(
      m.calls.find((call) => call.path === "devices.rename")?.input,
    ).toEqual({ id: otherId, name: "Laptop" })
    expect(m.container.textContent).toContain("Laptop")
  } finally {
    await m.close()
  }
})

for (const [code, message] of [
  ["NOT_FOUND", "This device was already removed."],
  ["INTERNAL_SERVER_ERROR", "Couldn’t rename this device. Try again."],
]) {
  test(`rename ${code} leaves the form open`, async () => {
    const m = await mounted({ renameError: code })
    try {
      await m.click("Rename", 1)
      await m.submit("Laptop")
      expect(m.container.textContent).toContain(message!)
      expect(m.container.querySelector("form")).not.toBeNull()
    } finally {
      await m.close()
    }
  })
}

for (const [code, success] of [
  ["NOT_FOUND", true],
  ["INTERNAL_SERVER_ERROR", false],
  [undefined, true],
] as const) {
  test(`remove ${code ?? "success"} shows row-only wording`, async () => {
    const m = await mounted({ removeError: code })
    try {
      await m.click("Remove")
      const dialog = m.window.document.body.querySelector(
        '[role="alertdialog"]',
      )!
      expect(m.window.document.body.textContent).toContain(
        "doesn’t sign that browser out",
      )
      expect(dialog.textContent).toContain("doesn’t sign that browser out")
      expect(dialog.textContent).not.toMatch(/Sign out|revoke/i)
      await m.click("Remove", 1)
      expect(
        !!m.window.document.body.querySelector('[role="alertdialog"]'),
      ).toBe(!success)
      if (!success)
        expect(dialog.textContent).toContain("Couldn’t remove this device")
    } finally {
      await m.close()
    }
  })
}

test("list errors can retry", async () => {
  const m = await mounted({ listError: true })
  try {
    expect(m.container.textContent).toContain("Couldn’t load devices.")
    await m.retryList()
    expect(m.container.textContent).toContain("Firefox")
  } finally {
    await m.close()
  }
})

test("anonymous Account does not call device APIs", async () => {
  const m = await mounted({
    user: { id: "anonymous", is_anonymous: true } as User,
    account: true,
  })
  try {
    expect(m.calls.filter((call) => call.path.startsWith("devices."))).toEqual(
      [],
    )
  } finally {
    await m.close()
  }
})
