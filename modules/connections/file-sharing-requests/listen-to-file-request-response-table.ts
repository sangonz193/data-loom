import { type AnyEventObject, fromCallback } from "xstate"

import { logger } from "@/logger"
import type { Database, Tables } from "@/supabase/types"
import { createClient } from "@/utils/supabase/client"

type Input = {
  supabase: ReturnType<typeof createClient>
  requestId: string
}

export type ListenToFileRequestResponseTableOutputEvent =
  | {
      type: "file-request-response"
      response: Tables<"share_request_responses">
    }
  | { type: "file-request-response.failed" }

export const listenToFileRequestResponseTable = fromCallback<
  AnyEventObject,
  Input
>((params) => {
  const sendBack = params.sendBack as (
    event: ListenToFileRequestResponseTableOutputEvent,
  ) => void
  const { supabase, requestId } = params.input

  let finished = false
  const controller = new AbortController()
  const deliver = (event: ListenToFileRequestResponseTableOutputEvent) => {
    if (finished) return
    finished = true
    sendBack(event)
  }
  const fail = (error: unknown) => {
    if (finished) return
    logger.error(
      "[listenToFileRequestResponseTable] Response listener failed",
      error,
    )
    deliver({ type: "file-request-response.failed" })
  }
  const readResponse = async () => {
    try {
      const { data, error } = await supabase
        .from("share_request_responses")
        .select()
        .eq("request_id", requestId)
        .abortSignal(controller.signal)
        .maybeSingle()
      if (error) throw error
      if (data) deliver({ type: "file-request-response", response: data })
    } catch (error) {
      fail(error)
    }
  }

  const channel = supabase
    .channel(`file_requests_response:${requestId}`, {
      config: { postgres_changes_options: { wait: true } },
    })
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
        deliver({
          type: "file-request-response",
          response: payload.new as Tables<"share_request_responses">,
        })
      },
    )
    .subscribe((status, error) => {
      if (finished) return
      if (error || status !== "SUBSCRIBED") {
        fail(error ?? new Error(status))
      } else {
        void readResponse()
      }
    })

  return () => {
    finished = true
    controller.abort()
    void supabase.removeChannel(channel)
  }
})
