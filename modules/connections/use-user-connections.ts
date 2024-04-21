import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

import { logger } from "@/logger"
import { Database, Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

import { useRequiredUser } from "../auth/use-user"

export function useUserConnectionsQuery() {
  const supabase = createClient()
  const user = useRequiredUser()

  const query = useQuery({
    queryKey: ["connections", user.id],
    queryFn: async () => {
      if (!user) return null as never

      const { data, error } = await supabase
        .from("user_connections")
        .select(
          `*,
          user_1:users!user_connections_user_1_id_fkey(
            *,
            animals(*),
            colors(*)
          ),
          user_2:users!user_connections_user_2_id_fkey(
            *,
            animals(*),
            colors(*)
          )`,
        )
        .or(
          `${"user_1_id" satisfies keyof Tables<"user_connections">}.eq.${user.id},${"user_2_id" satisfies keyof Tables<"user_connections">}.eq.${user.id}`,
        )

      if (error) {
        throw error
      }

      return data
    },
  })

  return query
}

export function useInvalidateUserConnectionsQuery() {
  const queryClient = useQueryClient()
  const supabase = createClient()
  const user = useRequiredUser()

  useEffect(() => {
    logger.info(
      "[useInvalidateUserConnectionsQuery] Subscribing to user_connections channel",
    )

    const channel = supabase
      .channel("user_connections")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table:
            "user_connections" satisfies keyof Database["public"]["Tables"],
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["connections", user.id] })
        },
      )
      .subscribe((status, error) => {
        if (error) {
          logger.error(
            "[useInvalidateUserConnectionsQuery] Error in channel",
            error,
          )
        } else {
          logger.info(
            "[useInvalidateUserConnectionsQuery] Channel status",
            status,
          )
        }
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient, supabase, user.id])
}
