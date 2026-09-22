"use client"

import { useEffect, useState } from "react"

import { registerDevice } from "./create/actions"

const storageKey = "data-loom-device-id"

export function useDevice() {
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

    registerDevice(id).then((registered) => {
      if (!cancelled) setDevice(registered)
    })

    return () => {
      cancelled = true
    }
  }, [])

  return device
}
