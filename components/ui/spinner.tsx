import { LoaderCircleIcon } from "lucide-react"

import { cn } from "@/lib/cn"

type Props = {
  className?: string
}

export function Spinner({ className }: Props) {
  return <LoaderCircleIcon className={cn("mx-auto animate-spin", className)} />
}
