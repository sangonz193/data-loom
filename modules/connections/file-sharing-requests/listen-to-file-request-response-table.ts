import { AnyEventObject, fromCallback } from "xstate"

import { logger } from "@/logger"
import { Database, Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

type Input = {
  supabase: ReturnType<typeof createClient>
  requestId: string
}

export type ListenToFileRequestResponseTableOutputEvent = {
  type: "file-request-response"
  response: Tables<"file_sharing_request_response">
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
          "file_sharing_request_response" satisfies keyof Database["public"]["Tables"],
        filter: `${"request_id" satisfies keyof Tables<"file_sharing_request_response">}=eq.${requestId}`,
      },
      (payload) => {
        const newRow = payload.new as Tables<"file_sharing_request_response">
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
