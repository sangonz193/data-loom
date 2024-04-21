import { themes } from "../colors"

export const tailwindColors: Record<string, Record<string, string> | string> =
  {}

const keys = Object.keys(themes.default.dark) as Array<
  keyof typeof themes.default.dark
>
const defaultColors = themes.default.dark

for (const key of keys) {
  const split = key.split("-")
  const group = split[0]
  const partOfGroup = keys.some((k) => k.startsWith(`${group}-`))
  const isDefault = group === key

  if (!partOfGroup) {
    tailwindColors[key] = getColorValue({
      key,
      defaultValue: defaultColors[key],
    })
    continue
  }

  if (tailwindColors[group] || !isDefault) {
    continue
  }

  const groupColors: Record<string, string> = {
    DEFAULT: getColorValue({ key, defaultValue: defaultColors[key] }),
  }

  keys
    .filter((k) => k.startsWith(`${group}-`))
    .map((key) => {
      const [, ...rest] = key.split("-")
      groupColors[rest.join("-")] = getColorValue({
        key,
        defaultValue: defaultColors[key],
      })
    })

  tailwindColors[group] = groupColors
}

function getColorValue({
  key,
  defaultValue,
}: {
  key: string
  defaultValue: string
}) {
  return `hsl(var(--${key}, ${defaultValue}) / <alpha-value>)`
}
