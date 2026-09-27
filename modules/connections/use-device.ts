"use client"

import { useEffect, useState } from "react"

import { useTRPCClient } from "@/modules/api/client"
import { useRequiredUser } from "@/modules/auth/use-user"

import { registerDevice } from "./register-device"

export function useDevice() {
  const trpcClient = useTRPCClient()
  const userId = useRequiredUser().id
  const [result, setResult] = useState<{
    userId: string
    device?: { id: string; personId: string }
    error?: boolean
  }>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    registerDevice(userId, (id) =>
      trpcClient.devices.register.mutate({ id }),
    ).then(
      (device) => {
        if (!cancelled) setResult({ userId, device })
      },
      () => {
        if (!cancelled) setResult({ userId, error: true })
      },
    )

    return () => {
      cancelled = true
    }
  }, [trpcClient, userId, attempt])

  return {
    device: result?.userId === userId ? result.device : undefined,
    error: result?.userId === userId && !!result.error,
    retry: () => {
      setResult(undefined)
      setAttempt((value) => value + 1)
    },
  }
}
