import { redirect } from "next/navigation"

import { AutoSignIn } from "@/modules/auth/auto-sign-in"
import { createClient } from "@/utils/supabase/server"

export type AutoLoginSearchParams = {
  redirectTo?: string
}

export default async function Page(props: {
  searchParams: Promise<AutoLoginSearchParams>
}) {
  const searchParams = await props.searchParams
  const redirectTo = searchParams.redirectTo
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect(redirectTo || "/home")
  }

  return <AutoSignIn />
}
