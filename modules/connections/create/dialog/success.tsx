import { CheckCircleIcon } from "lucide-react"

export function Success() {
  return (
    <div className="gap-3">
      <CheckCircleIcon className="mx-auto size-14 text-foreground" />

      <div>
        <span className="text-center text-lg">Connection successful</span>
        <span className="text-balance px-4 text-center text-muted-foreground">
          You can find this connection in your list of connections.
        </span>
      </div>
    </div>
  )
}
