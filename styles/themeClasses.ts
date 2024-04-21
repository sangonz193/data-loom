import type { themes } from "./colors"

export const themeClassNames: Record<keyof typeof themes, `theme-${string}`> = {
  default: "theme-default",
  red: "theme-red",
  orange: "theme-orange",
  green: "theme-green",
  blue: "theme-blue",
  rose: "theme-rose",
  violet: "theme-violet",
  yellow: "theme-yellow",
}
