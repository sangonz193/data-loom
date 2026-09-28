import { isIP } from "node:net"

export function trustedClientIp(
  headers: Headers,
  mode: string | undefined = process.env.NODE_ENV,
  vercel = process.env.VERCEL,
) {
  if (mode === "development" || mode === "test") return "127.0.0.1"
  if (mode !== "production" || vercel !== "1") return null
  const ip = headers.get("x-real-ip")
  if (!ip || !isIP(ip) || ip.includes("%")) return null
  if (isIP(ip) === 4) return ip
  const normalized = new URL(`http://[${ip}]`).hostname.slice(1, -1)
  const mapped = normalized.match(/^::ffff:([\da-f]+):([\da-f]+)$/)
  if (!mapped) return normalized
  const high = parseInt(mapped[1]!, 16)
  const low = parseInt(mapped[2]!, 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join(".")
}
