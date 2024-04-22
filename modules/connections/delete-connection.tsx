import { TrashIcon } from "lucide-react"

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
import { Tables, TablesInsert } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

type Props = {
  connection: Tables<"user_connections">
}

export function DeleteConnection({ connection }: Props) {
  const supabase = createClient()

  return (
    <AlertDialog>
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
            onClick={async () => {
              await supabase
                .from("user_connections")
                .delete()
                .match({
                  user_1_id: connection.user_1_id,
                  user_2_id: connection.user_2_id,
                } satisfies TablesInsert<"user_connections">)
            }}
            className={buttonVariants({ variant: "destructive" })}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
