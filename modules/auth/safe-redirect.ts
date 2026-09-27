export function safeRedirect(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return "/home"
  const url = new URL(value, "https://data-loom.invalid")
  if (
    url.origin !== "https://data-loom.invalid" ||
    url.pathname.startsWith("//")
  )
    return "/home"
  return `${url.pathname}${url.search}${url.hash}`
}
