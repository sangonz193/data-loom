import { PropsWithChildren } from "react"

import { Header } from "@/components/header"
import { RequiredAuthClient } from "@/modules/auth/required"
import { IncomingConnectionsProvider } from "@/modules/connections/incoming-connections"

import { assertUser } from "../utils/user-session"

export default async function Layout({ children }: PropsWithChildren) {
  const user = await assertUser()

  return (
    <RequiredAuthClient user={user}>
      <IncomingConnectionsProvider>
        <Header user={user} />
        {children}
      </IncomingConnectionsProvider>
    </RequiredAuthClient>
  )
}
