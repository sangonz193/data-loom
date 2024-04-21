import { User } from "@supabase/supabase-js"
import { fromPromise } from "xstate"

import { logger } from "@/logger"
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
  logger.info("[cleanUpSignalingRows] cleaning up signaling rows")
  await supabase.from("web_rtc_signals").delete().match({
    from_user_id: currentUser.id,
    to_user_id: remoteUserId,
  })
  logger.info("[cleanUpSignalingRows] cleaned up signaling rows")
}

export const cleanUpSignalingRowsActor = fromPromise<void, Input>(
  async ({ input }) => {
    await cleanUpSignalingRows(input)
  },
)
