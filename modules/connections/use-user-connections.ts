import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

import { logger } from "@/logger"
import type { Database } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

import { usePerson } from "./use-person"

export function useUserConnectionsQuery() {
  const supabase = createClient()
  const person = usePerson()

  return useQuery({
    queryKey: ["connections", person.data?.id],
    enabled: !!person.data,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("connections")
        .select(
          "*, person_1:people!connections_person_1_id_fkey(*, animals(*), colors(*)), person_2:people!connections_person_2_id_fkey(*, animals(*), colors(*))",
        )
      if (error) throw error
      return data
    },
  })
}

export function useInvalidateUserConnectionsQuery() {
  const queryClient = useQueryClient()
  const supabase = createClient()
  const person = usePerson()

  useEffect(() => {
    if (!person.data) return
    const channel = supabase
      .channel("connections")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "connections" satisfies keyof Database["public"]["Tables"],
        },
        () => {
          queryClient.invalidateQueries({
            queryKey: ["connections", person.data?.id],
          })
        },
      )
      .subscribe((status, error) => {
        if (error) logger.error("[connections] subscription failed", error)
        else logger.info("[connections] subscription", status)
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [person.data, queryClient, supabase])
}
