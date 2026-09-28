"use client"

import { useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createClient } from "@/utils/supabase/client"

import { authTransitions, runAuthTransition } from "../auth-transition"
import { useUser } from "../use-user"
import { AddDevice } from "./add-device"
import { Devices } from "./devices"
import { RequiredAuthClient } from "../required"

export function Account({ confirmation }: { confirmation?: string }) {
  const user = useUser()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [changingEmail, setChangingEmail] = useState(false)
  const supabase = createClient()

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError("")
    setMessage("")
    try {
      await runAuthTransition(action)
      await queryClient.invalidateQueries({ queryKey: ["user"] })
    } catch (error) {
      setError(
        (
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "email_exists"
        ) ?
          "That email already has an account. Use the sign-in form below."
        : error instanceof Error ? error.message
        : "Something went wrong. Please try again.",
      )
    } finally {
      setBusy(false)
    }
  }

  async function update(attributes: { email: string } | { password: string }) {
    const current = await supabase.auth.getUser()
    if (current.error) throw current.error
    if (current.data.user?.id !== user?.id)
      throw new Error(
        "Your account changed in another tab. Reload this page to continue.",
      )
    const { error } = await supabase.auth.updateUser(attributes, {
      emailRedirectTo: `${location.origin}/auth/callback`,
    })
    if (error) throw error
  }

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get("email"))
    void perform(async () => {
      await update({ email })
      setChangingEmail(false)
      setMessage("Confirmation email sent. Open the link in this browser.")
    })
  }

  return (
    <div className="mx-auto w-full max-w-md gap-6 px-4 py-8">
      <Link href={user ? "/home" : "/"} className="text-sm underline">
        Back to Data Loom
      </Link>
      <h1 className="text-2xl font-semibold">
        {user?.is_anonymous ? "Add a login" : "Account"}
      </h1>
      {confirmation === "done" && (
        <p role="status">
          Email confirmed. Set a password below to finish adding your login.
        </p>
      )}
      {confirmation === "elsewhere" && (
        <p role="status">
          Return to the browser where you requested this email to set your
          password. This browser could not complete confirmation.
        </p>
      )}
      {confirmation === "failed" && (
        <p role="alert">
          This confirmation link could not be used. Request another email from
          the browser where you started.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}

      {user?.is_anonymous && (
        <section className="flex flex-col gap-4" aria-label="Add a login">
          <p>
            Add an email and password to keep using this account on other
            devices. Your connections stay with this account.
          </p>
          {user.new_email && !changingEmail ?
            <div className="gap-3">
              <p>
                Confirm the link sent to {user.new_email}. Open it in this
                browser, then set a password.
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await update({ email: user.new_email! })
                    setMessage(
                      "Confirmation email sent. Open the newest link in this browser.",
                    )
                  })
                }
              >
                Resend email
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setChangingEmail(true)}
              >
                Change email
              </Button>
            </div>
          : <form onSubmit={submitEmail} className="flex flex-col gap-3">
              <label htmlFor="upgrade-email">Email</label>
              <Input
                id="upgrade-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                defaultValue={user.new_email}
                disabled={busy}
              />
              <Button disabled={busy}>Send confirmation email</Button>
            </form>
          }
        </section>
      )}

      {user && !user.is_anonymous ?
        <section className="flex flex-col gap-4" aria-label="Account settings">
          <p>Signed in as {user.email}</p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              const form = event.currentTarget
              const password = String(new FormData(form).get("password"))
              void perform(async () => {
                await update({ password })
                form.reset()
                setMessage(
                  "Password saved. You can now sign in with your email and password.",
                )
              })
            }}
          >
            <label
              htmlFor="new-password"
              className={
                confirmation === "done" ? "font-semibold text-primary" : ""
              }
            >
              Set or change password
            </label>
            <Input
              id="new-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
              disabled={busy}
            />
            <Button disabled={busy}>Save password</Button>
          </form>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const { error } = await supabase.auth.signOut({
                  scope: "local",
                })
                if (error) throw error
                await authTransitions.navigate("/")
              })
            }
          >
            Sign out of this browser
          </Button>
          <RequiredAuthClient user={user}>
            <Devices />
          </RequiredAuthClient>
          <AddDevice email={user.email} />
        </section>
      : <section
          className="flex flex-col gap-4"
          aria-labelledby="sign-in-heading"
        >
          <h2 id="sign-in-heading" className="text-lg font-semibold">
            Sign in
          </h2>
          {user?.is_anonymous && (
            <p id="sign-in-warning">
              Signing in to an existing account will not merge your anonymous
              connections. They will stay with your anonymous account and will
              no longer be available in this browser.
            </p>
          )}
          <Link href="/link-device" className="underline">
            Link this browser to an existing account
          </Link>
          <form
            className="flex flex-col gap-3"
            aria-describedby={
              user?.is_anonymous ? "sign-in-warning" : undefined
            }
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              void perform(async () => {
                const { error } = await supabase.auth.signInWithPassword({
                  email: String(data.get("email")),
                  password: String(data.get("password")),
                })
                if (error) throw error
                await authTransitions.navigate("/home")
              })
            }}
          >
            <label htmlFor="sign-in-email">Email</label>
            <Input
              id="sign-in-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              disabled={busy}
            />
            <label htmlFor="sign-in-password">Password</label>
            <Input
              id="sign-in-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={busy}
            />
            <Button disabled={busy}>Sign in</Button>
          </form>
        </section>
      }
    </div>
  )
}
