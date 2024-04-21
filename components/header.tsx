import { User } from "@supabase/supabase-js"

import { CreateConnectionDialog } from "@/modules/connections/create/dialog/create-connection-dialog"
import { createClient } from "@/utils/supabase/server"

import { Avatar } from "./avatar"

type Props = {
  user: User
}

export async function Header({ user }: Props) {
  const supabase = createClient()
  const { data: profile } = await supabase
    .from("users")
    .select("animals(*),colors(*)")
    .eq("id", user.id)
    .single()

  return (
    <div className="mx-auto h-14 w-full max-w-4xl flex-row items-center px-4">
      <Avatar
        animalEmoji={profile?.animals?.emoji}
        animalLabel={profile?.animals?.label}
        colorLabel={profile?.colors?.label}
        size="sm"
      />

      <CreateConnectionDialog className="ml-auto" />
    </div>
  )
}
