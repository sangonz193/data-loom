import { TRPCClientError } from "@trpc/client"

const storageKey = "data-loom-device-id"

type Device = { id: string; personId: string }
type Storage = Pick<typeof localStorage, "getItem" | "setItem">

const inFlight = new Map<string, Promise<Device>>()

export function registerDevice(
  userId: string,
  register: (id: string) => Promise<Device>,
  storage: Storage = localStorage,
) {
  const pending = inFlight.get(userId)
  if (pending) return pending

  const registration = (async () => {
    let id = storage.getItem(storageKey)
    if (!id) {
      id = crypto.randomUUID()
      storage.setItem(storageKey, id)
    }

    try {
      return await register(id)
    } catch (error) {
      if (
        !(error instanceof TRPCClientError) ||
        error.data?.code !== "FORBIDDEN" ||
        error.message !== "DEVICE_OWNED_BY_ANOTHER_PERSON"
      ) {
        throw error
      }

      const savedId = storage.getItem(storageKey)
      const nextId = savedId && savedId !== id ? savedId : crypto.randomUUID()
      storage.setItem(storageKey, nextId)
      return register(nextId)
    }
  })()

  inFlight.set(userId, registration)
  void registration.then(
    () => inFlight.delete(userId),
    () => inFlight.delete(userId),
  )
  return registration
}
