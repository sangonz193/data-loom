import type { SupabaseClient } from "@supabase/supabase-js"

export async function ensureSession(auth: SupabaseClient["auth"]) {
  const { data, error } = await auth.getSession()
  if (error) throw error
  if (data.session) return
  const result = await auth.signInAnonymously()
  if (result.error) throw result.error
}
