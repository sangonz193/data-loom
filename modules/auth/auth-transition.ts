const lockName = "data-loom-auth"

export const unsupportedAuthMessage =
  "This browser cannot safely coordinate sign-in across tabs. Use a current browser over HTTPS or localhost."

export function createAuthTransitions({
  locks,
  replace,
  reload,
}: {
  locks: () => LockManager | undefined
  replace: (path: string) => void
  reload: () => void
}) {
  let transitioning = false
  let reloading = false

  function manager() {
    const value = locks()
    if (!value) throw new Error(unsupportedAuthMessage)
    return value
  }

  async function navigate(path?: string) {
    if (path === undefined) reload()
    else replace(path)
    // Navigation is asynchronous; only document destruction may release this lock.
    await new Promise<never>(() => {})
  }

  async function run<T>(action: () => Promise<T>) {
    return manager().request(lockName, async () => {
      transitioning = true
      try {
        return await action()
      } finally {
        transitioning = false
      }
    })
  }

  async function reloadAfterTransition() {
    if (transitioning || reloading) return
    reloading = true
    try {
      await manager().request(lockName, () => navigate())
    } catch (error) {
      reloading = false
      throw error
    }
  }

  async function withIdentity<T>(
    expectedId: string,
    readId: () => Promise<string | undefined>,
    action: () => Promise<T>,
  ) {
    return manager().request(lockName, { mode: "shared" }, async () => {
      if ((await readId()) !== expectedId) return undefined
      return action()
    })
  }

  return { run, navigate, reloadAfterTransition, withIdentity }
}

export const authTransitions = createAuthTransitions({
  locks: () => navigator.locks,
  replace: (path) => location.replace(path),
  reload: () => location.reload(),
})

export const runAuthTransition = authTransitions.run
export const reloadAfterAuthTransition = authTransitions.reloadAfterTransition
