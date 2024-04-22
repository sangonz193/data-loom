"use client"

import { ComponentProps } from "react"

import { CreateConnectionDialog } from "@/modules/connections/create/dialog/create-connection-dialog"
import { useUserConnectionsQuery } from "@/modules/connections/use-user-connections"

type Props = ComponentProps<typeof CreateConnectionDialog>

export function HeaderCreateConnection(props: Props) {
  const { data } = useUserConnectionsQuery()

  if (!data?.length) return null

  return <CreateConnectionDialog {...props} />
}
