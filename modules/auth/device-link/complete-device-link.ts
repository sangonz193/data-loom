import type { Session, User } from "@supabase/supabase-js"
import { TRPCClientError } from "@trpc/client"

import type { AppRouter } from "@/modules/api/router"

export type LinkProgress = {
  message: string
  retry?: () => void
}

export function linkErrorCode(error: unknown) {
  return error instanceof TRPCClientError ?
      (error as TRPCClientError<AppRouter>).data?.code
    : undefined
}

const failures = {
  NOT_FOUND:
    "The code expired, was replaced, or belongs to a different account. Check the account and use a new code.",
  FORBIDDEN:
    "This device cannot use that setup code. Use a new code from your account.",
  PRECONDITION_FAILED:
    "This browser's account is no longer anonymous. Reload this page to continue.",
  CONFLICT: "The account is busy. Please try linking again.",
}

export async function completeDeviceLink({
  expectedUserId,
  readUser,
  signIn,
  complete,
  ownsDevice,
  signOut,
  installSession,
  navigate,
  progress,
}: {
  expectedUserId: string
  readUser: () => Promise<User | null>
  signIn: () => Promise<void>
  complete: () => Promise<void>
  ownsDevice: () => Promise<boolean>
  signOut: () => Promise<void>
  installSession: () => Promise<Session>
  navigate: () => Promise<void>
  progress: (state: LinkProgress) => void
}) {
  async function retry(message: string) {
    await new Promise<void>((resolve) => {
      progress({ message, retry: resolve })
    })
  }

  progress({ message: "Checking this browser's account…" })
  const user = await readUser()
  if (user?.id !== expectedUserId || !user.is_anonymous)
    throw new Error(
      "Your account changed in another tab. Reload this page to continue.",
    )

  progress({ message: "Signing in to your account…" })
  await signIn()

  let ambiguous = false
  let attempts = 0
  for (;;) {
    progress({ message: "Linking this browser. Keep this page open…" })
    attempts++
    try {
      await complete()
      break
    } catch (error) {
      const code = linkErrorCode(error)
      const failure =
        code && code in failures ?
          failures[code as keyof typeof failures]
        : undefined
      if (!failure) ambiguous = true

      if (code === "NOT_FOUND" || ambiguous) {
        try {
          if (await ownsDevice()) break
        } catch {
          await retry(
            "We couldn't check whether linking finished. Keep this page open and retry the check.",
          )
          continue
        }
      }

      // An earlier request can still commit after a timeout and a negative read.
      if (!ambiguous && failure) {
        await signOut().catch(() => undefined)
        throw new Error(failure)
      }
      if (attempts < 2) continue
      await retry(
        "Linking may still be finishing. Its status is unknown. Keep this page open and retry the check.",
      )
    }
  }

  for (;;) {
    progress({ message: "Your data is linked. Finishing sign-in…" })
    try {
      await installSession()
      break
    } catch {
      await retry(
        "Your data is linked, but sign-in could not finish. Retry, or open Account and sign in to the same account to recover.",
      )
    }
  }
  progress({ message: "Linked successfully. Opening your connections…" })
  await navigate()
}
