"use client"

import Link from "next/link"
import { useRef, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useTRPCClient } from "@/modules/api/client"
import { useDevice } from "@/modules/connections/use-device"
import { createClient } from "@/utils/supabase/client"

import { authTransitions } from "../auth-transition"
import { useRequiredUser } from "../use-user"
import { linkErrorCode } from "./complete-device-link"
import { createIsolatedAuth } from "./isolated-auth"
import { useDeviceLink } from "./provider"

export function LinkDevice() {
  const user = useRequiredUser()
  return (
    <div className="mx-auto w-full max-w-md gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Link this browser</h1>
      {user.is_anonymous ?
        <RegisterDevice />
      : <>
          <p>
            Already signed in as {user.email}. This browser does not need
            linking.
          </p>
          <Link href="/home" className="underline">
            Back to Data Loom
          </Link>
        </>
      }
    </div>
  )
}

function RegisterDevice() {
  const { device, error, retry } = useDevice()
  if (error)
    return (
      <>
        <p role="alert">Couldn’t register this browser.</p>
        <Button onClick={retry}>Retry</Button>
      </>
    )
  if (!device) return <p role="status">Registering this browser…</p>
  return <LinkForm deviceId={device.id} />
}

function LinkForm({ deviceId }: { deviceId: string }) {
  const user = useRequiredUser()
  const api = useTRPCClient()
  const [code, setCode] = useState("")
  const [redeemed, setRedeemed] = useState(false)
  const [redeeming, setBusy] = useState(false)
  const completion = useDeviceLink()
  const busy = redeeming || completion.busy
  const pending = useRef(false)
  const [error, setError] = useState("")

  async function redeem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current || completion.busy) return
    pending.current = true
    setBusy(true)
    setError("")
    try {
      await api.devices.link.mutate({ code: code.trim().toUpperCase() })
      setRedeemed(true)
    } catch (error) {
      setError(
        linkErrorCode(error) === "NOT_FOUND" ? "Code not found or expired."
        : linkErrorCode(error) === "FORBIDDEN" ?
          "This code is already used on another device, or this browser is no longer anonymous."
        : "Couldn't use this code. Please try again.",
      )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current || completion.busy) return
    const form = new FormData(event.currentTarget)
    setError("")
    const browser = createClient()
    const isolated = createIsolatedAuth()
    await completion.start({
      dispose: () => {
        void isolated.client.auth.dispose()
      },
      expectedUserId: user.id,
      readUser: async () => {
        const { data, error } = await browser.auth.getUser()
        if (error) throw error
        return data.user
      },
      signIn: async () => {
        const { error } = await isolated.client.auth.signInWithPassword({
          email: String(form.get("email")),
          password: String(form.get("password")),
        })
        if (error)
          throw new Error(
            "Couldn't sign in. Check the email and password. Confirm your email and set a password in Account on the other device first.",
          )
      },
      complete: () =>
        isolated.api.devices.completeLink.mutate({
          code: code.trim().toUpperCase(),
          deviceId,
        }),
      ownsDevice: async () => {
        const { data, error } = await isolated.client
          .from("devices")
          .select("id")
          .eq("id", deviceId)
          .maybeSingle()
        if (error) throw error
        return !!data
      },
      signOut: async () => {
        const { error } = await isolated.client.auth.signOut({
          scope: "local",
        })
        if (error) throw error
      },
      installSession: async () => {
        const { data, error } = await browser.auth.setSession(
          await isolated.session(),
        )
        if (error) throw error
        if (!data.session) throw new Error("Sign-in did not finish")
        return data.session
      },
      navigate: () => authTransitions.navigate("/home"),
    })
  }

  return (
    <>
      <p>
        Get a setup code from Account on your other device. Your anonymous
        connections will move to that account.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!redeemed ?
        <form onSubmit={redeem} className="flex flex-col gap-3">
          <label htmlFor="setup-code">Setup code</label>
          <Input
            id="setup-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            minLength={8}
            maxLength={8}
            required
            disabled={busy}
          />
          <Button disabled={busy}>Use setup code</Button>
        </form>
      : <form onSubmit={signIn} className="flex flex-col gap-3">
          <p>Sign in to the account that displayed this code.</p>
          <label htmlFor="link-email">Email</label>
          <Input
            id="link-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            disabled={busy}
          />
          <label htmlFor="link-password">Password</label>
          <Input
            id="link-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={busy}
          />
          <Button disabled={busy}>Sign in and link this browser</Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setRedeemed(false)
              setError("")
            }}
          >
            Use a different code
          </Button>
        </form>
      }
      {!busy && (
        <Link href="/home" className="underline">
          Cancel
        </Link>
      )}
    </>
  )
}
