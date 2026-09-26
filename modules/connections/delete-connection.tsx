"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { TrashIcon } from "lucide-react"
import { useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button, buttonVariants } from "@/components/ui/button"
import { useTRPC } from "@/modules/api/client"

type Props = { remotePersonId: string }

export function DeleteConnection({ remotePersonId }: Props) {
  const [open, setOpen] = useState(false)
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const deleteConnection = useMutation(
    trpc.connections.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["connections"] })
        setOpen(false)
      },
    }),
  )

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="icon" variant="destructive" title="Delete connection">
          <span className="sr-only">Delete connection</span>
          <TrashIcon className="size-5" />
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This will delete the connection. To communicate with this device
            again, you will need to create a new connection.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleteConnection.isPending}
            onClick={(event) => {
              event.preventDefault()
              deleteConnection.mutate({ remotePersonId })
            }}
            className={buttonVariants({ variant: "destructive" })}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
        {deleteConnection.error && (
          <p role="alert">Could not delete the connection. Please try again.</p>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
