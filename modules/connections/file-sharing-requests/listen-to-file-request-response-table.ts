import { type AnyEventObject, fromCallback } from "xstate"

import { logger } from "@/logger"
import type { Database, Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

type Input = {
  supabase: ReturnType<typeof createClient>
  requestId: string
}

export type ListenToFileRequestResponseTableOutputEvent = {
  type: "file-request-response"
  response: Tables<"share_request_responses">
}

export const listenToFileRequestResponseTable = fromCallback<
  AnyEventObject,
  Input
>((params) => {
  const sendBack = params.sendBack as (
    event: ListenToFileRequestResponseTableOutputEvent,
  ) => void
  const { supabase, requestId } = params.input

  const channel = supabase
    .channel("file_requests_response")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table:
          "share_request_responses" satisfies keyof Database["public"]["Tables"],
        filter: `${"request_id" satisfies keyof Tables<"share_request_responses">}=eq.${requestId}`,
      },
      (payload) => {
        const newRow = payload.new as Tables<"share_request_responses">
        logger.info(
          "[listenToFileRequestResponseTable] Received new file request response",
          newRow,
        )
        sendBack({ type: "file-request-response", response: newRow })
      },
    )
    .subscribe((status, error) => {
      if (error) {
        logger.error(
          "[listenToFileRequestResponseTable] Error subscribing to channel",
          error,
        )
      } else {
        logger.info(
          "[listenToFileRequestResponseTable] Subscribed to channel",
          status,
        )
      }
    })

  return () => {
    supabase.removeChannel(channel)
  }
})
