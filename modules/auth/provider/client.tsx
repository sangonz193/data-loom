"use client"

import { isAuthSessionMissingError, type User } from "@supabase/supabase-js"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useState,
} from "react"

import { createClient } from "@/utils/supabase/client"

import { authTransitions } from "../auth-transition"

interface Props extends PropsWithChildren {
  initialUser: User | null
  client?: ReturnType<typeof createClient>
  transitions?: typeof authTransitions
}

const AuthContext = createContext<{ user: User | undefined | null }>(
  null as any,
)

export function AuthProviderClient({
  initialUser,
  children,
  client,
  transitions = authTransitions,
}: Props) {
  const [renderedUser] = useState(initialUser)
  const [error, setError] = useState("")
  const supabase = client ?? createClient()
  const queryClient = useQueryClient()
  const userQuery = useQuery({
    queryKey: ["user"],
    queryFn: async () => {
      const { data, error } = await supabase.auth.getUser()
      if (error && !isAuthSessionMissingError(error)) throw error
      return data.user
    },
  })

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return
      // Defer SDK calls until the auth notification has released its lock.
      setTimeout(() => {
        if ((session?.user.id ?? null) !== (renderedUser?.id ?? null)) {
          void transitions
            .reloadAfterTransition()
            .catch((error: Error) => setError(error.message))
        } else {
          void queryClient.invalidateQueries({ queryKey: ["user"] })
        }
      }, 0)
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [queryClient, supabase.auth, renderedUser?.id, transitions])

  const currentUser = userQuery.data
  useEffect(() => {
    if (
      currentUser !== undefined &&
      (currentUser?.id ?? null) !== (renderedUser?.id ?? null)
    ) {
      void transitions
        .reloadAfterTransition()
        .catch((error: Error) => setError(error.message))
    }
  }, [currentUser, renderedUser?.id, transitions])

  return (
    <AuthContext.Provider
      value={{
        user: currentUser?.id === renderedUser?.id ? currentUser : renderedUser,
      }}
    >
      {error && <p role="alert">{error}</p>}
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
