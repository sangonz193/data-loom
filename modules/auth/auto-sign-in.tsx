"use client"

import { useMutation } from "@tanstack/react-query"
import { redirect } from "next/navigation"
import { useEffect } from "react"

import { Spinner } from "@/components/ui/spinner"
import { logger } from "@/logger"
import { createClient } from "@/utils/supabase/client"

type Props = {
  redirectTo: string | undefined
}

export function AutoSignIn({ redirectTo }: Props) {
  const { data, mutate, isPending } = useMutation({
    mutationFn: async () => {
      const supabase = createClient()

      return await supabase.auth.signInAnonymously().then((res) => {
        if (res.error) {
          logger.child(res.error).error("[auto-sign-in] Error")
          alert(res.error.message)
        }
        return res.data
      })
    },
  })

  useEffect(() => {
    let canceled = false

    ;(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (canceled) return

      mutate()
    })()

    return () => {
      canceled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (data?.user) redirect(redirectTo || "/home")

  return <>{isPending && <Spinner className="mx-auto mt-5" />}</>
}
