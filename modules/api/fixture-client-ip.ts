export function fixtureClientIp() {
  const hex = crypto.randomUUID().replaceAll("-", "")
  return `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}::1`
}
