import { TRPCClientError } from "@trpc/client"
import { expect, test } from "bun:test"

import { registerDevice } from "./register-device"

const staleId = crypto.randomUUID()

function storageWith(id: string | null) {
  let saved = id
  return {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value
    },
  }
}

function forbidden(message = "DEVICE_OWNED_BY_ANOTHER_PERSON") {
  return TRPCClientError.from({
    error: {
      code: -32003,
      message,
      data: { code: "FORBIDDEN", httpStatus: 403 },
    },
  })
}

test("replaces a foreign-owned saved ID and reuses the replacement", async () => {
  const storage = storageWith(staleId)
  const ids: string[] = []
  const register = async (id: string) => {
    ids.push(id)
    if (id === staleId) throw forbidden()
    return { id, personId: "new-person" }
  }

  const result = await registerDevice("new-user", register, storage)
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe(staleId)
  expect(result.id).not.toBe(staleId)
  expect(storage.getItem()).toBe(result.id)
  expect(await registerDevice("new-user", register, storage)).toEqual(result)
  expect(ids).toEqual([staleId, result.id, result.id])
})

test("reuses a saved ID already owned by the same person", async () => {
  const storage = storageWith(staleId)
  const ids: string[] = []
  const result = await registerDevice(
    "same-owner",
    async (id) => {
      ids.push(id)
      return { id, personId: "same-person" }
    },
    storage,
  )
  expect(result.id).toBe(staleId)
  expect(ids).toEqual([staleId])
  expect(storage.getItem()).toBe(staleId)
})

test("stops after one replacement attempt and allows a later retry", async () => {
  const storage = storageWith(staleId)
  const ids: string[] = []
  const register = async (
    id: string,
  ): Promise<{ id: string; personId: string }> => {
    ids.push(id)
    throw forbidden()
  }
  await expect(
    registerDevice("bounded-user", register, storage),
  ).rejects.toThrow()
  expect(ids).toHaveLength(2)
  expect(storage.getItem()).toBe(ids[1]!)
  await expect(
    registerDevice("bounded-user", register, storage),
  ).rejects.toThrow()
  expect(ids).toHaveLength(4)
  expect(ids[2]).toBe(ids[1])
})

test("keeps the saved ID for unrelated failures", async () => {
  for (const error of [
    forbidden("FORBIDDEN"),
    new Error("Network failure"),
    TRPCClientError.from({
      error: {
        code: -32001,
        message: "UNAUTHORIZED",
        data: { code: "UNAUTHORIZED", httpStatus: 401 },
      },
    }),
  ]) {
    const storage = storageWith(staleId)
    const ids: string[] = []
    await expect(
      registerDevice(
        crypto.randomUUID(),
        async (id): Promise<{ id: string; personId: string }> => {
          ids.push(id)
          throw error
        },
        storage,
      ),
    ).rejects.toBe(error)
    expect(ids).toEqual([staleId])
    expect(storage.getItem()).toBe(staleId)
  }
})

test("concurrent consumers share recovery, including one that leaves before completion", async () => {
  const storage = storageWith(staleId)
  const ids: string[] = []
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const register = async (id: string) => {
    ids.push(id)
    if (id === staleId) {
      await waiting
      throw forbidden()
    }
    return { id, personId: "new-person" }
  }
  const first = registerDevice("shared-user", register, storage)
  const second = registerDevice("shared-user", register, storage)
  expect(first).toBe(second)
  let active = true
  let updates = 0
  void first.then(() => {
    if (active) updates++
  })
  active = false
  release()
  const result = await second
  expect(ids).toHaveLength(2)
  expect(updates).toBe(0)
  expect(storage.getItem()).toBe(result.id)
})

test("a superseded saved ID is reused instead of rotated again", async () => {
  const storage = storageWith(staleId)
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const ids: string[] = []
  const pending = registerDevice(
    "later-user",
    async (id) => {
      ids.push(id)
      if (id === staleId) {
        await waiting
        throw forbidden()
      }
      return { id, personId: "later-person" }
    },
    storage,
  )
  const replacement = crypto.randomUUID()
  storage.setItem("data-loom-device-id", replacement)
  release()
  expect((await pending).id).toBe(replacement)
  expect(ids).toEqual([staleId, replacement])
  expect(storage.getItem()).toBe(replacement)
})
