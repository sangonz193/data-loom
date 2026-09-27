"use client"

import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { useTRPCClient } from "@/modules/api/client"
import { setupLinkUrl } from "@/modules/auth/device-link/setup-link"
import { DisplayCode } from "@/modules/connections/create/dialog/display-code"

export function AddDevice({ email }: { email: string | undefined }) {
  const api = useTRPCClient()
  const [code, setCode] = useState<{ code: string; created_at: string }>()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState("")

  async function createCode() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError("")
    try {
      setCode(await api.pairing.create.mutate({ purpose: "device" }))
    } catch {
      setError(
        "Couldn't get a setup code. Try again; a new code replaces any previous code.",
      )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Set up another device">
      <h2 className="text-lg font-semibold">Set up another device</h2>
      <p>
        On your other browser, open Account and choose “Link this browser to an
        existing account”. Enter this code, then sign in as {email}. Set a
        password above first if you haven’t already.
      </p>
      {code && (
        <DisplayCode
          code={code.code}
          createdAt={code.created_at}
          heading="Your setup code is:"
          instruction="Enter this code on the browser you want to link."
          qrValue={setupLinkUrl(location.origin, code.code, email)}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy} onClick={() => void createCode()}>
        {code ? "New code (replaces previous code)" : "Get setup code"}
      </Button>
    </section>
  )
}
