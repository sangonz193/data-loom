import { createAdminClient } from "@/utils/supabase/admin"
import { createClient } from "@/utils/supabase/server"

export async function createContext(request: Request) {
  const authorization = request.headers.get("authorization")
  const token = authorization?.match(/^Bearer (\S+)$/i)?.[1]
  if (authorization && !token) return { userId: null }

  const supabase = token ? createAdminClient() : await createClient()
  try {
    const { data, error } = await supabase.auth.getClaims(token)
    return { userId: error ? null : data?.claims.sub ?? null }
  } catch {
    return { userId: null }
  }
}
