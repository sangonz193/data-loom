import { redirect } from "next/navigation"

import { createClient } from "@/utils/supabase/server"

export function getUser() {
  const supabase = createClient()
  return supabase.auth.getUser().then(({ data }) => data.user)
}

export async function assertUser({
  redirectTo,
}: {
  redirectTo?: string
} = {}) {
  const user = await getUser()

  if (!user) {
    let path = "/auto-login"
    if (redirectTo) {
      path += `?redirectTo=${encodeURIComponent(redirectTo)}`
    }

    redirect(path)
  }

  return user
}
