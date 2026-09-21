import { fromPromise } from "xstate"

import { createClient } from "@/utils/supabase/client"

type Input = {
  supabase: ReturnType<typeof createClient>
  remoteUserId: string
}

export async function cleanUpSignalingRows() {}

export const cleanUpSignalingRowsActor = fromPromise<void, Input>(async () => {
  await cleanUpSignalingRows()
})
