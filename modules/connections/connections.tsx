"use client"

import { Spinner } from "@/components/ui/spinner"

import { Connection } from "./connection"
import {
  useInvalidateUserConnectionsQuery,
  useUserConnectionsQuery,
} from "./use-user-connections"

export function Connections() {
  const { data, isLoading } = useUserConnectionsQuery()
  useInvalidateUserConnectionsQuery()

  return (
    <div className="mx-auto w-full max-w-lg gap-4 p-4">
      {isLoading && <Spinner />}

      {data?.map((connection) => (
        <Connection
          key={`${connection.user_1_id}_${connection.user_2_id}`}
          connection={connection}
        />
      ))}
    </div>
  )
}
