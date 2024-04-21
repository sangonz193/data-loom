import { PropsWithChildren } from "react"

import { Header } from "@/components/header"

import { assertUser } from "../utils/user-session"

export default async function Layout({ children }: PropsWithChildren) {
  await assertUser()

  return (
    <div>
      <Header />
      {children}
    </div>
  )
}
