import { type AnyEventObject, fromCallback } from "xstate"

import { logger } from "@/logger"
import type { Database, Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

type Input = {
  supabase: ReturnType<typeof createClient>
}

export type ListenToFileRequestTableOutputEvent = {
  type: "file-request.request"
  fileRequest: Tables<"share_requests">
}

export const listenToFileRequestTable = fromCallback<AnyEventObject, Input>(
  (params) => {
    const sendBack = params.sendBack as (
      event: ListenToFileRequestTableOutputEvent,
    ) => void
    const { supabase } = params.input

    const channel = supabase
      .channel("file_requests")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "share_requests" satisfies keyof Database["public"]["Tables"],
        },
        (payload) => {
          const newRow = payload.new as Tables<"share_requests">
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
