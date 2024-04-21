"use client"

import { User } from "@supabase/supabase-js"
import { redirect, usePathname } from "next/navigation"
import { PropsWithChildren, createContext, useContext } from "react"

import { AutoLoginSearchParams } from "@/app/auto-login/page"

import { useUser } from "./use-user"

interface Props extends PropsWithChildren {
  // Not used, but required to make sure a user is logged in
  user: User
}

const Context = createContext<{ user: User }>(null as any)

export function RequiredAuthClient({ children }: Props) {
  const user = useUser()
  const pathname = usePathname()

  if (!user)
    redirect(
      `/auto-login?${"redirectTo" satisfies keyof AutoLoginSearchParams}=${encodeURIComponent(pathname)}`,
    )

  return <Context.Provider value={{ user }}>{children}</Context.Provider>
}

export function useRequiredAuth() {
  const value = useContext(Context)
  if (!value) {
    throw new Error("useRequiredAuth must be used within a RequiredAuth")
  }

  return value
}
