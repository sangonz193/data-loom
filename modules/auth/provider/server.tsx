import { PropsWithChildren } from "react"

import { getUser } from "@/app/utils/user-session"

import { AuthProviderClient } from "./client"

export async function AuthProvider({ children }: PropsWithChildren) {
  const user = await getUser()

  return <AuthProviderClient initialUser={user}>{children}</AuthProviderClient>
}
