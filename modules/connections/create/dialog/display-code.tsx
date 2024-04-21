import { CheckIcon, CopyIcon } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"

type Props = {
  code: string
}

export function DisplayCode({ code }: Props) {
  const [copied, setCopied] = useState(0)

  useEffect(() => {
    if (!copied) return

    const timeout = setTimeout(() => {
      setCopied(0)
    }, 2000)

    return () => clearTimeout(timeout)
  }, [copied])

  const Icon = copied ? CheckIcon : CopyIcon

  return (
    <>
      <span>Your connection code is:</span>
      <div className="mx-auto flex-row items-center gap-3">
        <span className="text-center text-2xl">{code}</span>

        <Button
          size="icon"
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
    </>
  )
}
