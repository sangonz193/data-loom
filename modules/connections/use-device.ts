"use client"

import { useEffect, useState } from "react"

import { useTRPCClient } from "@/modules/api/client"

const storageKey = "data-loom-device-id"

export function useDevice() {
  const trpcClient = useTRPCClient()
  const [device, setDevice] = useState<
    { id: string; personId: string } | undefined
  >()

  useEffect(() => {
    let cancelled = false
    let id = localStorage.getItem(storageKey)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(storageKey, id)
    }

    trpcClient.devices.register.mutate({ id }).then((registered) => {
      if (!cancelled) setDevice(registered)
    })

    return () => {
      cancelled = true
    }
  }, [trpcClient])

  return device
}
