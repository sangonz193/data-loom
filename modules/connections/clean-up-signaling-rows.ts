import { User } from "@supabase/supabase-js"
import { fromPromise } from "xstate"

import { createClient } from "@/utils/supabase/client"

type Input = {
  supabase: ReturnType<typeof createClient>
  currentUser: User
  remoteUserId: string
}

export async function cleanUpSignalingRows({
  currentUser,
  supabase,
  remoteUserId,
}: Input) {
  await supabase.from("web_rtc_signals").delete().match({
    from_user_id: currentUser.id,
    to_user_id: remoteUserId,
  })
}

export const cleanUpSignalingRowsActor = fromPromise<void, Input>(
  async ({ input }) => {
    await cleanUpSignalingRows(input)
  },
)
