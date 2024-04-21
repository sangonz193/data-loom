import type { themes } from "./colors"

export const themeClassNames: Record<keyof typeof themes, `theme-${string}`> = {
  default: "theme-default",
}
