import { mock } from "bun:test"

import { createAuthTransitions } from "./auth-transition"

export function lockHarness() {
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
    locks,
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
