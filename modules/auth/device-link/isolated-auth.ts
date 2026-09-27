import { createClient } from "@supabase/supabase-js"
import { createTRPCClient, httpLink } from "@trpc/client"
import superjson from "superjson"

import type { AppRouter } from "@/modules/api/router"
import type { Database } from "@/supabase/types"

export function createIsolatedFetch(fetcher: typeof fetch) {
  const isolatedFetch: typeof fetch = async (input, init) => {
    const caller =
      init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const controller = new AbortController()
    const abort = () => controller.abort(caller?.reason)
    if (caller?.aborted) abort()
    else caller?.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(
      () =>
        controller.abort(new DOMException("Request timed out", "TimeoutError")),
      15_000,
    )
    try {
      const response = await fetcher(input, {
        ...init,
        credentials: "omit",
        signal: controller.signal,
      })
      // Keep cancellation active until the auth response body has arrived.
      await response.clone().arrayBuffer()
      return response
    } finally {
      clearTimeout(timeout)
      caller?.removeEventListener("abort", abort)
    }
  }
  return isolatedFetch
}

export function createIsolatedAuth({
  url = process.env.NEXT_PUBLIC_SUPABASE_URL!,
  key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  apiUrl = "/api/trpc",
  fetcher = fetch,
} = {}) {
  const isolatedFetch = createIsolatedFetch(fetcher)
  const client = createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "data-loom-device-link",
    },
    global: { fetch: isolatedFetch },
  })
  async function session() {
    const { data, error } = await client.auth.getSession()
    if (error) throw error
    if (!data.session)
      throw new Error(
        "Sign in again through Account to recover a completed link.",
      )
    return data.session
  }
  const api = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: apiUrl,
        transformer: superjson,
        headers: async () => ({
          authorization: `Bearer ${(await session()).access_token}`,
        }),
        fetch: isolatedFetch,
      }),
    ],
  })
  return { client, api, session }
}
