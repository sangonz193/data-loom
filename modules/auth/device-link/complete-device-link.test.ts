import type { Session, User } from "@supabase/supabase-js"
import { TRPCClientError } from "@trpc/client"
import { expect, mock, test } from "bun:test"

import { ensureSession } from "../anonymous-sign-in"
import { lockHarness } from "../test-locks"
import { completeDeviceLink, type LinkProgress } from "./complete-device-link"

function rpcError(code: string) {
  return new TRPCClientError(code, {
    result: { error: { message: code, code: -32004, data: { code } } },
  })
}

async function settle() {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

function fixture() {
  const locks = lockHarness()
  const tab = locks.tab("link")
  const events = [] as string[]
  let user = { id: "B", is_anonymous: true } as User
  let state: LinkProgress = { message: "" }
  const deps = {
    expectedUserId: "B",
    readUser: mock(async () => {
      events.push("identity")
      return user
    }),
    signIn: mock(async () => {
      events.push("signIn")
    }),
    complete: mock(async () => {
      events.push("complete")
    }),
    ownsDevice: mock(async () => false),
    signOut: mock(async () => {}),
    installSession: mock(async () => {
      events.push("install")
      user = { id: "A", is_anonymous: false } as User
      return { user } as Session
    }),
    navigate: () => {
      events.push("navigate")
      return tab.transitions.navigate("/home")
    },
    progress: (value: LinkProgress) => {
      state = value
    },
  }
  return {
    locks,
    tab,
    events,
    deps,
    state: () => state,
    run: () => tab.transitions.run(() => completeDeviceLink(deps)),
  }
}

test("completion precedes installation and navigation retains the lock until document destruction", async () => {
  const f = fixture()
  void f.run()
  await settle()
  expect(f.events).toEqual([
    "identity",
    "signIn",
    "complete",
    "install",
    "navigate",
  ])
  expect(f.tab.replace).toHaveBeenCalledWith("/home")
  const action = mock(async () => {})
  const queued = f.locks.tab("other").transitions.run(action)
  await settle()
  expect(action).not.toHaveBeenCalled()
  expect(f.deps.signOut).not.toHaveBeenCalled()
  f.locks.destroy("link")
  await queued
  expect(action).toHaveBeenCalledTimes(1)
})

test("wrong password leaves B untouched, releases the lock, and allows retry", async () => {
  const f = fixture()
  f.deps.signIn.mockRejectedValueOnce(new Error("wrong password"))
  await expect(f.run()).rejects.toThrow("wrong password")
  expect(f.deps.complete).not.toHaveBeenCalled()
  expect(f.deps.installSession).not.toHaveBeenCalled()
  void f.run()
  await settle()
  expect(f.deps.installSession).toHaveBeenCalledTimes(1)
  f.locks.destroy("link")
})

for (const user of [
  { id: "C", is_anonymous: true },
  { id: "B", is_anonymous: false },
]) {
  test(`identity guard refuses ${JSON.stringify(user)} before isolated sign-in`, async () => {
    const f = fixture()
    f.deps.readUser.mockResolvedValue(user as User)
    await expect(f.run()).rejects.toThrow("account changed")
    expect(f.deps.signIn).not.toHaveBeenCalled()
    expect(f.deps.complete).not.toHaveBeenCalled()
  })
}

for (const [code, message] of [
  ["NOT_FOUND", "expired"],
  ["FORBIDDEN", "cannot use"],
  ["PRECONDITION_FAILED", "no longer anonymous"],
  ["CONFLICT", "busy"],
] as const) {
  test(`${code} without an earlier ambiguous request is safe to report`, async () => {
    const f = fixture()
    f.deps.complete.mockRejectedValue(rpcError(code))
    await expect(f.run()).rejects.toThrow(message)
    expect(f.deps.signOut).toHaveBeenCalledTimes(1)
    expect(f.deps.installSession).not.toHaveBeenCalled()
    expect(f.deps.ownsDevice).toHaveBeenCalledTimes(
      code === "NOT_FOUND" ? 1 : 0,
    )
  })
}

for (const error of [
  rpcError("NOT_FOUND"),
  new TypeError("lost response"),
  rpcError("INTERNAL_SERVER_ERROR"),
]) {
  test(`visible device confirms completion after ${error.message}`, async () => {
    const f = fixture()
    f.deps.complete.mockRejectedValue(error)
    f.deps.ownsDevice.mockImplementation(async () => {
      f.events.push("read")
      return true
    })
    void f.run()
    await settle()
    expect(f.events.indexOf("read")).toBeLessThan(f.events.indexOf("install"))
    expect(f.deps.complete).toHaveBeenCalledTimes(1)
    expect(f.deps.signOut).not.toHaveBeenCalled()
    expect(f.deps.installSession).toHaveBeenCalledTimes(1)
    f.locks.destroy("link")
  })
}

test("network failure retries completion only once automatically", async () => {
  const f = fixture()
  f.deps.complete.mockRejectedValueOnce(new TypeError("offline"))
  void f.run()
  await settle()
  expect(f.deps.complete).toHaveBeenCalledTimes(2)
  expect(f.deps.ownsDevice).toHaveBeenCalledTimes(1)
  expect(f.deps.installSession).toHaveBeenCalledTimes(1)
  f.locks.destroy("link")
})

for (const second of [
  "NOT_FOUND",
  "FORBIDDEN",
  "PRECONDITION_FAILED",
  "CONFLICT",
  "INTERNAL_SERVER_ERROR",
]) {
  test(`delayed commit after lost acknowledgement and ${second} retains A until manual reconciliation`, async () => {
    const f = fixture()
    let committed = false
    const delayedCommit = Promise.withResolvers<void>()
    void delayedCommit.promise.then(() => {
      committed = true
    })
    f.deps.complete
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockRejectedValue(rpcError(second))
    f.deps.ownsDevice.mockImplementation(async () => committed)
    void f.run()
    await settle()
    expect(f.deps.complete).toHaveBeenCalledTimes(2)
    expect(f.deps.ownsDevice).toHaveBeenCalledTimes(2)
    expect(f.state().message).toContain("unknown")
    expect(f.state().retry).toBeFunction()
    expect(f.deps.signOut).not.toHaveBeenCalled()
    expect(f.deps.installSession).not.toHaveBeenCalled()
    const action = mock(async () => {})
    const queued = f.locks.tab("other").transitions.run(action)
    await settle()
    expect(action).not.toHaveBeenCalled()
    delayedCommit.resolve()
    await settle()
    expect(f.deps.complete).toHaveBeenCalledTimes(2)
    f.state().retry!()
    await settle()
    expect(f.deps.complete).toHaveBeenCalledTimes(3)
    expect(f.deps.installSession).toHaveBeenCalledTimes(1)
    expect(f.deps.signOut).not.toHaveBeenCalled()
    f.locks.destroy("link")
    await queued
  })
}

test("failed reconciliation exposes retry while keeping the lock and session", async () => {
  const f = fixture()
  f.deps.complete.mockRejectedValue(rpcError("NOT_FOUND"))
  f.deps.ownsDevice
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(true)
  void f.run()
  await settle()
  expect(f.state().message).toContain("couldn't check")
  expect(f.deps.complete).toHaveBeenCalledTimes(1)
  expect(f.deps.signOut).not.toHaveBeenCalled()
  expect(f.deps.installSession).not.toHaveBeenCalled()
  f.state().retry!()
  await settle()
  expect(f.deps.installSession).toHaveBeenCalledTimes(1)
  f.locks.destroy("link")
})

test("installation retries retain the lock and never revoke the installed session", async () => {
  const f = fixture()
  f.deps.installSession.mockRejectedValueOnce(new TypeError("offline"))
  void f.run()
  await settle()
  expect(f.state().message).toContain("data is linked")
  expect(f.deps.installSession).toHaveBeenCalledTimes(1)
  expect(f.tab.replace).not.toHaveBeenCalled()
  const queuedAction = mock(async () => {})
  const queued = f.locks.tab("other").transitions.run(queuedAction)
  await settle()
  expect(queuedAction).not.toHaveBeenCalled()
  f.state().retry!()
  await settle()
  expect(f.deps.installSession).toHaveBeenCalledTimes(2)
  expect(f.deps.complete).toHaveBeenCalledTimes(1)
  expect(f.deps.signOut).not.toHaveBeenCalled()
  expect(f.tab.replace).toHaveBeenCalledWith("/home")
  f.locks.destroy("link")
  await queued
})

test("other tabs cannot register or create an anonymous session before installation and navigation", async () => {
  const f = fixture()
  const gate = Promise.withResolvers<void>()
  f.deps.complete.mockImplementation(() => gate.promise)
  void f.run()
  await settle()
  const home = f.locks.tab("home")
  const register = mock(async () => "device")
  const queuedRegistration = home.transitions.withIdentity(
    "B",
    async () => (await f.deps.readUser()).id,
    register,
  )
  const signInAnonymously = mock(async () => ({ error: null }))
  const queuedEnsure = f.locks.tab("auto").transitions.run(() =>
    ensureSession({
      getSession: async () => ({
        data: { session: { user: await f.deps.readUser() } },
        error: null,
      }),
      signInAnonymously,
    } as unknown as Parameters<typeof ensureSession>[0]),
  )
  await settle()
  expect(register).not.toHaveBeenCalled()
  expect(signInAnonymously).not.toHaveBeenCalled()
  gate.resolve()
  await settle()
  expect(register).not.toHaveBeenCalled()
  f.locks.destroy("link")
  expect(await queuedRegistration).toBeUndefined()
  await queuedEnsure
  expect(register).not.toHaveBeenCalled()
  expect(signInAnonymously).not.toHaveBeenCalled()
  void home.transitions.reloadAfterTransition()
  await settle()
  expect(home.reload).toHaveBeenCalledTimes(1)
  f.locks.destroy("home")
})
