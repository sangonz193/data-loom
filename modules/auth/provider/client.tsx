"use client"

import { User } from "@supabase/supabase-js"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { PropsWithChildren, createContext, useContext, useEffect } from "react"

import { createClient } from "@/utils/supabase/client"

interface Props extends PropsWithChildren {
  initialUser: User | null
}

const AuthContext = createContext<{ user: User | undefined | null }>(
  null as any,
)

export function AuthProviderClient({ initialUser, children }: Props) {
  const supabase = createClient()
  const queryClient = useQueryClient()
  const userQuery = useQuery({
    queryKey: ["user"],
    queryFn: async () => {
      return (await supabase.auth.getUser()).data.user
    },
  })

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      queryClient.invalidateQueries({ queryKey: ["user"] })
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [queryClient, supabase.auth])

  return (
    <AuthContext.Provider value={{ user: userQuery.data || initialUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthContext() {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error("useAuthContext must be used within an AuthProvider")
  }

  return value
}
