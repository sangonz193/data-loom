"use client"

import { SquirrelIcon } from "lucide-react"

import { Spinner } from "@/components/ui/spinner"

import { CreateConnectionDialog } from "./create/dialog/create-connection-dialog"
import { IncomingFileSharingRequestsProvider } from "./file-sharing-requests/incoming-file-sharing-requests"
import { Connection } from "./item/connection"
import {
  useInvalidateUserConnectionsQuery,
  useUserConnectionsQuery,
} from "./use-user-connections"

export function Connections() {
  const { data, isLoading } = useUserConnectionsQuery()
  useInvalidateUserConnectionsQuery()

  return (
    <IncomingFileSharingRequestsProvider>
      <div className="mx-auto w-full max-w-lg gap-4 p-4">
        {isLoading && <Spinner />}

        {!!data?.length && (
          <span className="text-sm text-muted-foreground">
            To send a file, click the {'"'}Send File{'"'} button in a connection
            or drag and drop a file onto a connection.
          </span>
        )}

        {data?.map((connection) => (
          <Connection
            key={`${connection.user_1_id}_${connection.user_2_id}`}
            connection={connection}
          />
        ))}

        {!isLoading && !data?.length && <EmptyState />}
      </div>
    </IncomingFileSharingRequestsProvider>
  )
}

function EmptyState() {
  return (
    <div className="mt-3 gap-4">
      <SquirrelIcon
        className="mx-auto size-40 text-muted-foreground opacity-50"
        strokeWidth={0.5}
      />

      <div>
        <div className="text-center text-xl text-muted-foreground">
          No connections yet
        </div>

        <div className="mt-1 text-center text-muted-foreground">
          To start sharing files, create a connection with another device.
        </div>
      </div>

      <CreateConnectionDialog size="default" className="mt-10" />
    </div>
  )
}
