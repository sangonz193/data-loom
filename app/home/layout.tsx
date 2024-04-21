import { PropsWithChildren } from "react"

import { Header } from "@/components/header"
import { RequiredAuthClient } from "@/modules/auth/required"

import { assertUser } from "../utils/user-session"

export default async function Layout({ children }: PropsWithChildren) {
  const user = await assertUser()

  return (
    <RequiredAuthClient user={user}>
      <Header user={user} />
      {children}
    </RequiredAuthClient>
  )
}
