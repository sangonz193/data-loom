import { redirect } from "next/navigation"

import { AutoSignIn } from "@/modules/auth/auto-sign-in"
import { createClient } from "@/utils/supabase/client"

export type AutoLoginSearchParams = {
  redirectTo?: string
}

export default async function Page(props: {
  searchParams: AutoLoginSearchParams
}) {
  const { searchParams } = props
  const redirectTo = searchParams.redirectTo
  const supabase = createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect(redirectTo || "/home")
  }

  return <AutoSignIn redirectTo={redirectTo} />
}
