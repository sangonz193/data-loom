import { CSSRuleObject, PluginAPI } from "tailwindcss/types/config"

import { themes } from "../colors"

export const plugin = (api: PluginAPI) => {
  const baseStyles: CSSRuleObject = {}

  for (const [themeName, colors] of Object.entries(themes)) {
    baseStyles[`.theme-${themeName}`] = {
      ...themeColorsToVars(colors.light),
      "@media (prefers-color-scheme: dark)": themeColorsToVars(colors.dark),
    }
  }

  api.addBase(baseStyles)
}

function themeColorsToVars(theme: Record<string, string>) {
  return Object.entries(theme).reduce(
    (acc, [key, value]) => {
      acc[`--${key}`] = value
      return acc
    },
    {} as Record<string, string>,
  )
}
