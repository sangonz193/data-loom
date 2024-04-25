import { XCircleIcon } from "lucide-react"

export function ConnectionErrored() {
  return (
    <div className="gap-3">
      <XCircleIcon className="mx-auto size-14 text-destructive" />

      <div className="gap-2 text-balance text-foreground">
        <span>
          Couldn’t establish a direct link between the devices. For a better
          chance at a successful connection, consider these tips:
        </span>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Avoid using public Wi-Fi or mobile data, as these networks might
            restrict peer-to-peer connections.
          </li>
          <li>
            Ensure that firewall settings or other network restrictions are not
            blocking the connection.
          </li>
          <li>
            If possible, connect both devices to the same Wi-Fi network. This
            often helps but is not required.
          </li>
        </ul>
      </div>
    </div>
  )
}
