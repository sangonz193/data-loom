import {
  addMinutes,
  interval,
  intervalToDuration,
  formatDuration,
  milliseconds,
  Duration,
} from "date-fns"
import { CheckIcon, CopyIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

import { CODE_EXPIRATION_MINUTES } from "../constants"

type Props = {
  code: string
  createdAt: string
}

export function DisplayCode(props: Props) {
  const { code, createdAt } = props
  const [copied, setCopied] = useState(0)

  useEffect(() => {
    if (!copied) return

    const timeout = setTimeout(() => {
      setCopied(0)
    }, 2000)

    return () => clearTimeout(timeout)
  }, [copied])

  const Icon = copied ? CheckIcon : CopyIcon

  const parsedCreatedAt = useMemo(() => new Date(createdAt), [createdAt])
  const expiresAt = useMemo(
    () => addMinutes(parsedCreatedAt, CODE_EXPIRATION_MINUTES),
    [parsedCreatedAt],
  )
  const duration = intervalToDuration(interval(new Date(), expiresAt))
  const isExpired = milliseconds(duration) <= 0

  const [, setTick] = useState(false)
  useEffect(() => {
    if (isExpired) return

    const interval = setInterval(() => {
      setTick((tick) => !tick)
    }, 1000)

    return () => clearInterval(interval)
  }, [isExpired])

  return (
    <div className="gap-3">
      <span
        className={cn(
          "opacity-100 transition-opacity",
          isExpired && "opacity-30",
        )}
      >
        Your connection code is:
      </span>
      <div
        className={cn(
          "relative mx-auto flex-row items-center gap-3 opacity-100 transition-opacity",
          isExpired && "opacity-50",
        )}
      >
        <Button size="icon" disabled className="invisible">
          <span className="sr-only">Copy</span>
          <Icon className="size-5" />
        </Button>

        <span className="text-center font-mono text-2xl">{code}</span>

        <Button
          size="icon"
          disabled={isExpired}
          onClick={() =>
            navigator.clipboard.writeText(code).then(() => {
              setCopied(copied + 1)
            })
          }
        >
          <span className="sr-only">Copy</span>
          <Icon className="size-5" />
        </Button>
      </div>

      <ExpNotice duration={duration} isExpired={isExpired} />
    </div>
  )
}

function ExpNotice({
  duration,
  isExpired,
}: {
  duration: Duration
  isExpired: boolean
}) {
  if (isExpired) {
    return (
      <span className="mt-4 text-red-500">
        This code has expired. Please generate a new one.
      </span>
    )
  }

  return (
    <span className="mt-4 text-sm text-popover-foreground/60">
      Enter this code on the other device to connect. The code will expire in{" "}
      {isExpired ? "0 seconds" : formatDuration(duration)}.
    </span>
  )
}
