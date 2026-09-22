import type { User } from "@supabase/supabase-js"

import { createClient } from "@/utils/supabase/server"

import { Avatar, getUserName } from "./avatar"
import { HeaderCreateConnection } from "./header-create-connection"

type Props = {
  user: User
}

export async function Header({ user }: Props) {
  const supabase = await createClient()
  const { data: profile } = await supabase
    .from("people")
    .select("animals(*),colors(*)")
    .eq("auth_user_id", user.id)
    .single()

  return (
    <div className="mx-auto h-16 w-full max-w-4xl flex-row items-center gap-3 px-4">
      <Avatar
        animalEmoji={profile?.animals?.emoji}
        animalLabel={profile?.animals?.label}
        colorLabel={profile?.colors?.label}
        size="sm"
      />

      <span className="text-muted-foreground">
        {getUserName({
          animalLabel: profile?.animals?.label,
          colorLabel: profile?.colors?.label,
        })}{" "}
        <span className="text-xs">(You)</span>
      </span>

      <HeaderCreateConnection className="ml-auto" />
    </div>
  )
}
