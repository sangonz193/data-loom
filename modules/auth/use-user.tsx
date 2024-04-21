import { useQuery } from "@tanstack/react-query"

import { createClient } from "@/utils/supabase/client"

export function useUserQuery() {
  const supabase = createClient()
  const query = useQuery({
    queryKey: ["user"],
    queryFn: async () => {
      return (await supabase.auth.getUser()).data.user
    },
  })

  return query
}
