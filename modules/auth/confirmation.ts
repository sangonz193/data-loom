export async function confirmationDestination(
  params: URLSearchParams,
  exchange: (code: string) => Promise<{ error: { code?: string } | null }>,
) {
  const code = params.get("code")
  if (params.has("error") || !code) return "/account?confirmation=failed"
  try {
    const { error } = await exchange(code)
    const state =
      !error ? "done"
      : error.code === "pkce_code_verifier_not_found" ? "elsewhere"
      : "failed"
    return `/account?confirmation=${state}`
  } catch {
    return "/account?confirmation=failed"
  }
}
