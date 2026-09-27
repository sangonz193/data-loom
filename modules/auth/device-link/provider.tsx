"use client"

import {
  createContext,
  useContext,
  useRef,
  useState,
  type PropsWithChildren,
} from "react"

import { Button } from "@/components/ui/button"

import { runAuthTransition } from "../auth-transition"
import { completeDeviceLink, type LinkProgress } from "./complete-device-link"

type Completion = Omit<Parameters<typeof completeDeviceLink>[0], "progress"> & {
  dispose: () => void
}

const Context = createContext<{
  busy: boolean
  start: (completion: Completion) => Promise<void>
} | null>(null)

export function DeviceLinkProvider({ children }: PropsWithChildren) {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<LinkProgress>()
  const [error, setError] = useState("")

  async function start({ dispose, ...completion }: Completion) {
    if (pending.current) {
      dispose()
      return
    }
    pending.current = true
    setBusy(true)
    setError("")
    try {
      await runAuthTransition(() =>
        completeDeviceLink({ ...completion, progress: setProgress }),
      )
    } catch (error) {
      setError(
        error instanceof Error ?
          error.message
        : "Couldn't link this browser. Please try again.",
      )
    } finally {
      dispose()
      pending.current = false
      setBusy(false)
      setProgress(undefined)
    }
  }

  return (
    <Context.Provider value={{ busy, start }}>
      {(progress || error) && (
        <section
          aria-label="Browser linking"
          className="mx-auto w-full max-w-md gap-3 px-4 py-4"
        >
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {progress && (
            <>
              <p role="status">{progress.message}</p>
              {progress.retry && (
                <Button
                  onClick={() => {
                    setProgress({ message: "Retrying…" })
                    progress.retry!()
                  }}
                >
                  Retry check
                </Button>
              )}
              <p>
                If you close this page after linking finishes, sign in to the
                same account through{" "}
                <a className="underline" href="/account">
                  Account
                </a>{" "}
                to recover your connections.
              </p>
            </>
          )}
        </section>
      )}
      {children}
    </Context.Provider>
  )
}

export function useDeviceLink() {
  const value = useContext(Context)
  if (!value)
    throw new Error("useDeviceLink must be used within a DeviceLinkProvider")
  return value
}
