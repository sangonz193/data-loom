"use client"

import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

import { Spinner } from "@/components/ui/spinner"
import { logger } from "@/logger"
import { createClient } from "@/utils/supabase/client"

export function AutoSignIn() {
  const { data, mutate, isPending } = useMutation({
    mutationFn: async () => {
      const supabase = createClient()

      const data = await supabase.auth.signInAnonymously().then(async (res) => {
        if (res.error) {
          logger.child(res.error).error("[auto-sign-in] Error")
          alert(res.error.message)
        }

        return res.data
      })

      return data
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

  const router = useRouter()
  useEffect(() => {
    if (data?.user) {
      router.refresh()
    }
  }, [data?.user, router])

  return <>{isPending && <Spinner className="mx-auto mt-5" />}</>
}
