import { PropsWithChildren } from "react"

import { assertUser } from "../utils/user-session"

export default async function Layout({ children }: PropsWithChildren) {
  await assertUser()

  return <div>{children}</div>
}
