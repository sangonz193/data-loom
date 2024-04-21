import { User } from "@supabase/supabase-js"
import { AnyEventObject, fromCallback } from "xstate"

import { logger } from "@/logger"
import { Database, Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

type Input = {
  supabase: ReturnType<typeof createClient>
  currentUser: User
}

export type ListenToFileRequestTableOutputEvent = {
  type: "file-request.request"
  fileRequest: Tables<"file_sharing_request">
}

export const listenToFileRequestTable = fromCallback<AnyEventObject, Input>(
  (params) => {
    const sendBack = params.sendBack as (
      event: ListenToFileRequestTableOutputEvent,
    ) => void
    const { supabase, currentUser } = params.input

    const channel = supabase
      .channel("file_requests")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table:
            "file_sharing_request" satisfies keyof Database["public"]["Tables"],
          filter: `${"to_user_id" satisfies keyof Tables<"file_sharing_request">}=eq.${currentUser.id}`,
        },
        (payload) => {
          const newRow = payload.new as Tables<"file_sharing_request">
          logger.info(
            "[listenToFileRequestTable] Received new file request",
            newRow,
          )
          sendBack({ type: "file-request.request", fileRequest: newRow })
        },
      )
      .subscribe((status, error) => {
        if (error) {
          logger.error(
            "[listenToFileRequestTable] Error subscribing to channel",
            error,
          )
        } else {
          logger.info(
            "[listenToFileRequestTable] Subscribed to channel",
            status,
          )
        }
      })

    return () => {
      supabase.removeChannel(channel)
    }
  },
)
