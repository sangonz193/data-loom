import {
  CODE_ALPHABET,
  CODE_LENGTH,
} from "@/modules/connections/create/constants"

const codePattern = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`)
const hintPattern = /^[a-z0-9]\*\*\*@[a-z0-9-]+(\.[a-z0-9-]+)+$/
const maxHintLength = 255
// URLSearchParams encodes the hint's @ as %40; its other allowed characters stay literal.
const maxHashLength =
  "#setup=".length + CODE_LENGTH + "&hint=".length + maxHintLength + 2

export function maskEmail(email?: string) {
  if (!email) return undefined
  const [local, domain] = email.toLowerCase().split("@")
  if (!local || !/^[a-z0-9]$/.test(local[0] ?? "") || !domain) return undefined
  const hint = `${local[0]}***@${domain}`
  return hint.length <= maxHintLength && hintPattern.test(hint) ?
      hint
    : undefined
}

export function setupLinkUrl(origin: string, code: string, email?: string) {
  const params = new URLSearchParams({ setup: code })
  const hint = maskEmail(email)
  if (hint) params.set("hint", hint)
  return `${origin}/link-device#${params}`
}

export function parseSetupLink(hash: string) {
  if (!hash.startsWith("#") || hash.length > maxHashLength) return undefined
  const params = new URLSearchParams(hash.slice(1))
  const code = params.get("setup")
  if (!code || !codePattern.test(code)) return undefined
  const rawHint = params.get("hint")
  const hint =
    rawHint && rawHint.length <= maxHintLength && hintPattern.test(rawHint) ?
      rawHint
    : undefined
  return { code, ...(hint ? { hint } : {}) }
}
