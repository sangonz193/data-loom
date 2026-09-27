"use client"

import { useEffect, useRef, useState } from "react"

import { Spinner } from "@/components/ui/spinner"
import { createClient } from "@/utils/supabase/client"

import { ensureSession } from "./anonymous-sign-in"
import { authTransitions, runAuthTransition } from "./auth-transition"
import { withCurrentFragment } from "./safe-redirect"

export function AutoSignIn({ destination }: { destination: string }) {
  const started = useRef(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (started.current) return
    started.current = true
    void runAuthTransition(async () => {
      await ensureSession(createClient().auth)
      await authTransitions.navigate(
        withCurrentFragment(destination, location.hash),
      )
    }).catch((error: Error) => setError(error.message))
  }, [destination])

  return error ?
      <p role="alert">{error}</p>
    : <Spinner className="mx-auto mt-5" />
}
