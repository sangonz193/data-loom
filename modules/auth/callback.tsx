"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"

import { createClient } from "@/utils/supabase/client"

import { authTransitions, runAuthTransition } from "./auth-transition"
import { confirmationDestination } from "./confirmation"

export function AuthCallback() {
  const started = useRef(false)
  const [error, setError] = useState("")
  useEffect(() => {
    if (started.current) return
    started.current = true
    void runAuthTransition(async () => {
      const destination = await confirmationDestination(
        new URLSearchParams(location.search),
        (code) => createClient().auth.exchangeCodeForSession(code),
      )
      await authTransitions.navigate(destination)
    }).catch((error: Error) => setError(error.message))
  }, [])
  return (
    <div className="mx-auto max-w-md gap-4 p-6">
      <p role={error ? "alert" : "status"}>
        {error || "Confirming your email…"}
      </p>
      {error && <Link href="/account">Back to account</Link>}
    </div>
  )
}
