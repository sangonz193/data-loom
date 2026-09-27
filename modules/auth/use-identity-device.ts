import { useEffect, useState } from "react"

import { authTransitions } from "./auth-transition"

type Device = { id: string; personId: string }

export function useIdentityDevice(
  userId: string,
  readId: () => Promise<string | undefined>,
  register: () => Promise<Device>,
  transitions = authTransitions,
) {
  const [result, setResult] = useState<{
    userId: string
    device?: Device
    error?: boolean
  }>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    void transitions
      .withIdentity(userId, readId, async () => {
        if (cancelled) return
        const device = await register()
        if (!cancelled) setResult({ userId, device })
        return device
      })
      .then((device) => {
        if (!device && !cancelled) return transitions.reloadAfterTransition()
      })
      .catch(() => {
        if (!cancelled) setResult({ userId, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [userId, readId, register, transitions, attempt])

  return {
    device: result?.userId === userId ? result.device : undefined,
    error: result?.userId === userId && !!result.error,
    retry: () => {
      setResult(undefined)
      setAttempt((value) => value + 1)
    },
  }
}
