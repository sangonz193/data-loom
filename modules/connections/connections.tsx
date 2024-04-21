"use client"

import { Spinner } from "@/components/ui/spinner"

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

        {!isLoading && !data?.length && (
          <div className="text-center text-muted-foreground">
            No connections yet
          </div>
        )}
      </div>
    </IncomingFileSharingRequestsProvider>
  )
}
