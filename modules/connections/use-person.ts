import { useQuery } from "@tanstack/react-query"

import { createClient } from "@/utils/supabase/client"

import { useRequiredUser } from "../auth/use-user"

export function usePerson() {
  const user = useRequiredUser()
  const supabase = createClient()

  return useQuery({
    queryKey: ["person", user.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("people")
        .select("*")
        .eq("auth_user_id", user.id)
        .single()
      if (error) throw error
      return data
    },
  })
}
