import {
  addMinutes,
  interval,
  intervalToDuration,
  formatDuration,
  milliseconds,
  type Duration,
} from "date-fns"
import { CheckIcon, CopyIcon } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

import { CODE_EXPIRATION_MINUTES } from "../constants"

type Props = {
  code: string
  createdAt: string
  heading?: string
  instruction?: string
  qrValue?: string
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
        {props.heading ?? "Your connection code is:"}
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

      {props.qrValue && !isExpired && (
        <div className="flex flex-col items-center gap-2">
          <QRCodeSVG
            value={props.qrValue}
            size={192}
            marginSize={4}
            level="M"
            bgColor="#FFFFFF"
            fgColor="#000000"
            title="Scan to open device setup"
          />
          <p className="text-center text-sm">
            Scan with your phone camera to open setup in its default browser. To
            link a different browser, type the code there.
          </p>
        </div>
      )}

      <ExpNotice
        duration={duration}
        isExpired={isExpired}
        instruction={props.instruction}
      />
    </div>
  )
}

function ExpNotice({
  duration,
  isExpired,
  instruction,
}: {
  duration: Duration
  isExpired: boolean
  instruction?: string
}) {
  if (isExpired) {
    return (
      <span className="mt-4 text-red-500">
        This code has expired. Please generate a new one.
      </span>
    )
  }

  return (
    <span className="mt-4 whitespace-pre-wrap text-sm text-popover-foreground/60">
      {instruction ?? "Enter this code on the other device to connect."}
      {"\n"}The code will expire in{" "}
      <span className="text-foreground">
        {isExpired ? "0 seconds" : formatDuration(duration)}
      </span>
      .
    </span>
  )
}
