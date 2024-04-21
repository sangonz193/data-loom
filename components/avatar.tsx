import { cn } from "@/lib/cn"

type Props = {
  colorLabel: string | undefined
  animalLabel: string | undefined
  animalEmoji: string | undefined
  size?: "sm" | "lg"
}

export function Avatar({
  animalEmoji,
  animalLabel,
  colorLabel,
  size = "lg",
}: Props) {
  const title = getUserName({ animalLabel, colorLabel })

  return (
    <div
      className={cn(
        "h-20 w-20 items-center justify-center rounded-full border-2 border-primary bg-primary/10",
        size === "sm" && "h-11 w-11",
      )}
      title={title}
    >
      <span className={cn("text-4xl leading-none", size === "sm" && "text-xl")}>
        {animalEmoji}
      </span>
    </div>
  )
}

export function getUserName({
  animalLabel,
  colorLabel,
}: {
  animalLabel: string | undefined
  colorLabel: string | undefined
}) {
  return [colorLabel, animalLabel].filter(Boolean).join(" ")
}
